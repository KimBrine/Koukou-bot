import { getProbeTarget } from './probe-settings.mjs'
/**
 * 视觉模型横评：同一张真实群图，分别丢给当前视觉模型和 DeepSeek 自家模型，
 * 比延迟、比描述质量。用来回答"换个模型会不会更快"。
 *
 *   node scripts/probe-vision-latency.mjs [群号] [参照次数]
 *
 * **只调用模型，不发任何消息。**
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'
import { imageToDataUrl } from '../src/bot.js'
import { VISION_DESCRIBE_PROMPT, VISION_DESCRIBE_ASK, sanitizeImageDescription } from '../src/visionNote.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || getProbeTarget('group'))
const rounds = Math.max(1, Math.min(5, Number(process.argv[3]) || 2))

// 被测模型：当前用的 + DeepSeek 自家两个
const CANDIDATES = [
  { name: 'qwen3.7-flash（当前）', baseUrl: config.dashscopeBaseUrl, apiKey: config.dashscopeApiKey, model: config.dashscopeModel },
  { name: 'deepseek-flash', baseUrl: config.deepseekBaseUrl, apiKey: config.deepseekApiKey, model: 'deepseek-flash' },
  { name: 'deepseek-v4-pro', baseUrl: config.deepseekBaseUrl, apiKey: config.deepseekApiKey, model: 'deepseek-v4-pro' },
]

async function describe(cand, dataUrl) {
  const body = {
    model: cand.model,
    messages: [
      { role: 'system', content: VISION_DESCRIBE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_DESCRIBE_ASK },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.3,
    max_tokens: 400,
    stream: false,
  }
  const t0 = Date.now()
  const res = await fetch(cand.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cand.apiKey },
    body: JSON.stringify(body),
  })
  // ⚠️ 必须等到 body 读完再计时：fetch 的 Promise 只等到**响应头**，
  // 服务端用 chunked 时头会很早到，此时计时会得到一个假的很低的数字。
  const j = await res.json().catch(() => ({}))
  const ms = Date.now() - t0
  if (!res.ok) return { ms, error: (j.error?.message || JSON.stringify(j)).slice(0, 160) }
  const msg = j.choices?.[0]?.message || {}
  const text = typeof msg.content === 'string' ? msg.content.trim() : ''
  // DeepSeek 的推理模型可能把内容放在 reasoning_content 里
  return { ms, text, reasoning: msg.reasoning_content ? String(msg.reasoning_content).length : 0, usage: j.usage }
}

onebot.on('ready', async () => {
  try {
    const hist = await onebot.getGroupMsgHistory(group, null, 20000, 150)
    const msgs = hist?.messages || []
    const withImg = msgs.filter((m) => parseMessage(m.message ?? m.raw_message, null).images.length > 0)
    if (withImg.length === 0) {
      console.log('这段历史里没有带图的消息，换个群号或稍后再试')
      onebot.stop()
      process.exit(0)
    }
    const target = withImg[withImg.length - 1]
    const parsed = parseMessage(target.message ?? target.raw_message, null)
    const part = await imageToDataUrl(parsed.images[0], onebot, config, logger)
    if (!part) {
      console.log('图片没取到')
      onebot.stop()
      process.exit(1)
    }
    const dataUrl = part.image_url.url
    const kb = Math.round(dataUrl.length / 1024)
    const t = new Date(Number(target.time) * 1000).toLocaleString('zh-CN', { hour12: false })
    console.log(`测试图：群 ${group} ${t} 发送，data URL ${kb} KB（base64 后大小，约为原图 1.33 倍）`)
    console.log(`每轮都把**同一张图**发给所有模型，跑 ${rounds} 轮取平均\n`)

    const stats = new Map(CANDIDATES.map((c) => [c.name, []]))
    for (let r = 1; r <= rounds; r++) {
      console.log(`──── 第 ${r} 轮 ────`)
      for (const cand of CANDIDATES) {
        try {
          const out = await describe(cand, dataUrl)
          if (out.error) {
            console.log(`  ${cand.name.padEnd(22)} ❌ ${out.ms}ms  ${out.error}`)
            continue
          }
          stats.get(cand.name).push(out.ms)
          const desc = sanitizeImageDescription(out.text)
          const usage = out.usage ? ` tokens(in ${out.usage.prompt_tokens}/out ${out.usage.completion_tokens})` : ''
          console.log(`  ${cand.name.padEnd(22)} ⏱ ${(out.ms / 1000).toFixed(1)}s${usage}`)
          console.log(`      ${desc.slice(0, 90) || '(空回答)'}${desc.length > 90 ? '…' : ''}`)
        } catch (e) {
          console.log(`  ${cand.name.padEnd(22)} ❌ 请求异常：${e.message}`)
        }
      }
      console.log('')
    }

    console.log('──── 平均延迟 ────')
    for (const cand of CANDIDATES) {
      const arr = stats.get(cand.name)
      if (arr.length === 0) {
        console.log(`  ${cand.name.padEnd(22)} 无有效样本`)
        continue
      }
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length
      console.log(`  ${cand.name.padEnd(22)} ${(avg / 1000).toFixed(1)}s  (${arr.map((x) => (x / 1000).toFixed(1)).join(' / ')}s)`)
    }
  } catch (err) {
    console.error('测试失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 600000)
