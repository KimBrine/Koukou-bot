import { getProbeTarget } from './probe-settings.mjs'
/**
 * 图片回复回归验证：把当时闯祸的那张图，同时跑「旧流程」和「新流程」做对照。
 *
 *   2026-09-23 22:20 群 200000002，群友 714qc 发了张图，机器人回了：
 *   「这是一段非常典型的**大学生QQ群…以下是对这段聊天记录及最后图片的详细解读：### 1. 核心事件：…」
 *
 *   旧流程：人设提示词 + 历史 + 图片 一起丢给视觉模型，让它直接写回复 → 写成分析报告
 *   新流程：视觉模型只读图 → 文字模型照常写人设回复（图片内容作为内部备注）
 *
 *   node scripts/test-vision-two-step.mjs [群号] [聊天记录条数]
 *
 * **只调用模型，不发任何消息。**
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'
import { DeepSeekClient } from '../src/deepseek.js'
import { buildChatAppendix } from '../src/chatAppendix.js'
import { imageToDataUrl } from '../src/bot.js'
import {
  VISION_DESCRIBE_PROMPT,
  VISION_DESCRIBE_ASK,
  sanitizeImageDescription,
  buildImageContextNote,
  looksLikeReport,
} from '../src/visionNote.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || getProbeTarget('group'))
const count = Math.max(20, Math.min(200, Number(process.argv[3]) || 120))

const visionLLM = new DeepSeekClient({
  apiKey: config.dashscopeApiKey,
  baseUrl: config.dashscopeBaseUrl,
  model: config.dashscopeModel,
  temperature: 0.3,
  maxTokens: 400,
  timeoutMs: config.timeoutMs,
  maxRetries: 1,
  maxConcurrency: config.maxConcurrency,
  logger,
  label: '视觉模型',
})
const llm = new DeepSeekClient({
  apiKey: config.deepseekApiKey,
  baseUrl: config.deepseekBaseUrl,
  model: config.deepseekModel,
  temperature: config.temperature,
  maxTokens: Math.min(config.maxTokens, 2000),
  timeoutMs: config.timeoutMs,
  maxRetries: 1,
  maxConcurrency: config.maxConcurrency,
  logger,
  label: '文字模型',
})

onebot.on('ready', async () => {
  try {
    const hist = await onebot.getGroupMsgHistory(group, null, 20000, count)
    const msgs = hist?.messages || []
    console.log(`群 ${group} 取到 ${msgs.length} 条历史\n`)

    // 找"带图 + 有文字上下文"的消息作为被测对象（优先最新的）
    const withImg = msgs.filter((m) => parseMessage(m.message ?? m.raw_message, null).images.length > 0)
    if (withImg.length === 0) {
      console.log('这段历史里没有带图的消息，换个群号或调大条数试试')
      onebot.stop()
      process.exit(0)
    }
    const target = withImg[withImg.length - 1]
    const parsed = parseMessage(target.message ?? target.raw_message, null)
    const senderName = target.sender?.card || target.sender?.nickname || String(target.user_id)
    const when = new Date(Number(target.time) * 1000).toLocaleString('zh-CN', { hour12: false })
    console.log(`被测消息：${when}　${senderName}：${parsed.text || '(纯图)'}`)
    console.log(`图片 ${parsed.images.length} 张\n`)

    const dataUrls = []
    for (const img of parsed.images.slice(0, config.visionMaxImages)) {
      const part = await imageToDataUrl(img, onebot, config, logger)
      if (part) dataUrls.push(part)
    }
    if (dataUrls.length === 0) {
      console.log('图片没取到，无法验证')
      onebot.stop()
      process.exit(1)
    }
    console.log(`图片已取到 ${dataUrls.length} 张（data URL 长度 ${dataUrls.map((d) => d.image_url.url.length).join(', ')}）\n`)

    const restText = parsed.text.replace(/\[图片\]/g, '').trim()
    const imgLabel = dataUrls.length > 1 ? `${dataUrls.length} 张图片/表情包` : '一张图片/表情包'
    const visionText = `${senderName} 在群里发了${imgLabel}${restText ? `，还说：${restText}` : ''}`
    const content = `【${senderName}】${parsed.text}`
    const systemPrompt = `${config.persona}${buildChatAppendix({ time: new Date().toLocaleString('zh-CN', { hour12: false }) })}`

    // 还原生产环境：把这条图片消息之前的真实聊天记录作为 baseHistory，
    // 这样才能测出"模型会不会自顾自接着聊历史话题、完全不理会图片"
    const targetIdx = msgs.indexOf(target)
    const baseHistory = msgs
      .slice(Math.max(0, targetIdx - 12), targetIdx)
      .map((m) => {
        const p = parseMessage(m.message ?? m.raw_message, null)
        const nm = m.sender?.card || m.sender?.nickname || String(m.user_id)
        return {
          role: String(m.user_id) === String(onebot.selfId) ? 'assistant' : 'user',
          content: String(m.user_id) === String(onebot.selfId) ? p.text : `【${nm}】${p.text}`,
        }
      })
      .filter((m) => m.content && m.content.trim())
    console.log(`还原上下文 ${baseHistory.length} 条历史消息：`)
    for (const h of baseHistory.slice(-5)) {
      console.log(`   [${h.role}] ${h.content.slice(0, 70)}`)
    }
    console.log()

    console.log('══════════ 旧流程：视觉模型直接写回复（chatVision）══════════')
    let oldReply = ''
    if (process.env.SKIP_OLD === '1') {
      console.log('（SKIP_OLD=1，跳过旧流程对照）')
    } else {
      try {
        const t0 = Date.now()
        oldReply = await visionLLM.chatVision(systemPrompt, baseHistory, visionText, dataUrls)
        console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
        console.log(oldReply)
        console.log(`\n→ 像分析报告？ ${looksLikeReport(oldReply) ? '❌ 是（这就是 bug）' : '✅ 否'}`)
      } catch (err) {
        console.log(`旧流程调用失败：${err.message}`)
      }
    }

    console.log('\n══════════ 新流程：① 视觉模型只读图 ══════════')
    let desc = ''
    try {
      const t0 = Date.now()
      const raw = await visionLLM.describeImages(VISION_DESCRIBE_PROMPT, `${visionText}\n${VISION_DESCRIBE_ASK}`, dataUrls)
      desc = sanitizeImageDescription(raw)
      console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      console.log(`读图结果（${desc.length} 字）：${desc}`)
      console.log(`→ 像分析报告？ ${looksLikeReport(desc) ? '❌ 是' : '✅ 否'}`)
    } catch (err) {
      console.log(`读图失败：${err.message}`)
    }

    console.log('\n══════════ 新流程：② 文字模型写人设回复 ══════════')
    try {
      const t0 = Date.now()
      // 与生产一致：读图结果同时进系统提示词（备注）和本轮用户消息（[图片内容：…]）
      const imageUserContent = desc ? content.replace(/\[图片\]/g, `[图片内容：${desc}]`) : content
      const reply = await llm.chat(
        desc ? systemPrompt + buildImageContextNote(desc) : systemPrompt,
        [...baseHistory, { role: 'user', content: imageUserContent }]
      )
      console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      console.log(reply)
      const bad = looksLikeReport(reply)
      console.log(`\n→ 像分析报告？ ${bad ? '❌ 是（还会被兜底拦下重生成）' : '✅ 否'}`)
      // 关键质量检查：回复有没有真的针对图片内容（而不是接着历史话题自说自话）。
      // 注意别用"图/画面"这类字眼来判断——真人回应图片时往往直接说图里的东西
      //（例：读图写"大斧头"，回复写"这斧头挥得虎虎生风"，一个字都没提"图"）。
      // 所以用二元字组重合度判断：回复和读图结果共享了具体名词才算真的看了图。
      const bigrams = (s) => {
        const set = new Set()
        for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2))
        return set
      }
      const descGrams = bigrams(desc)
      const shared = [...bigrams(reply)].filter((g) => descGrams.has(g))
      console.log(`→ 有没有回应图片内容？ ${shared.length > 0 ? `✅ 有（共享词：${shared.slice(0, 6).join('、')}）` : '⚠ 没有（在接着历史话题聊）'}`)
      console.log(`\n结论：${bad ? '⚠ 新流程仍会漏，需要再调' : '✅ 新流程修好了'}`)
    } catch (err) {
      console.log(`新流程调用失败：${err.message}`)
    }
  } catch (err) {
    console.error('验证失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 180000)
