/**
 * 验证"机器人实际用的那条读图路径"能不能跑通、要多久。
 *
 *   node scripts/test-vision-provider.mjs [群号]
 *
 * 与 probe-vision-latency.mjs 的区别：那个直接打原始 HTTP 接口做横评；
 * 这个**完全按 src/index.js 的方式构造视觉客户端**，再调 bot.js 用的同一个
 * describeImages()，所以验证的是真实链路（含 provider 选择、超时、重试、清洗）。
 *
 * **只调用模型，不发任何消息。**
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'
import { DeepSeekClient } from '../src/deepseek.js'
import { imageToDataUrl } from '../src/bot.js'
import { VISION_DESCRIBE_PROMPT, VISION_DESCRIBE_ASK, sanitizeImageDescription, buildImageContextNote } from '../src/visionNote.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || 1124442491)

// 完全照 src/index.js 的构造方式
const isDeepseek = config.visionProvider === 'deepseek'
const visionLLM = new DeepSeekClient({
  apiKey: isDeepseek ? config.deepseekApiKey : config.dashscopeApiKey,
  baseUrl: isDeepseek ? config.deepseekBaseUrl : config.dashscopeBaseUrl,
  model: isDeepseek ? config.visionModel || 'deepseek-flash' : config.dashscopeModel,
  temperature: config.temperature,
  maxTokens: Math.min(config.maxTokens, 300),
  timeoutMs: config.timeoutMs,
  maxRetries: config.maxRetries,
  maxConcurrency: config.maxConcurrency,
  logger,
  label: isDeepseek ? 'DeepSeek 视觉' : '通义千问VL',
})

onebot.on('ready', async () => {
  try {
    console.log(`provider = ${config.visionProvider}`)
    console.log(`模型     = ${isDeepseek ? config.visionModel || 'deepseek-flash' : config.dashscopeModel}`)
    console.log(`baseUrl  = ${isDeepseek ? config.deepseekBaseUrl : config.dashscopeBaseUrl}`)
    console.log(`超时     = ${config.timeoutMs}ms\n`)

    const hist = await onebot.getGroupMsgHistory(group, null, 20000, 150)
    const msgs = hist?.messages || []
    const withImg = msgs.filter((m) => parseMessage(m.message ?? m.raw_message, null).images.length > 0)
    if (withImg.length === 0) {
      console.log('没找到带图的消息，换个群号或稍后再试')
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
    const kb = Math.round(part.image_url.url.length / 1024)
    const when = new Date(Number(target.time) * 1000).toLocaleString('zh-CN', { hour12: false })
    console.log(`测试图：群 ${group} ${when} 发送，${kb} KB\n`)

    for (let i = 1; i <= 2; i++) {
      const t0 = Date.now()
      try {
        const raw = await visionLLM.describeImages(VISION_DESCRIBE_PROMPT, VISION_DESCRIBE_ASK, [part])
        const ms = Date.now() - t0
        const desc = sanitizeImageDescription(raw)
        console.log(`第 ${i} 次：⏱ ${(ms / 1000).toFixed(1)}s  清洗后 ${desc.length} 字`)
        console.log(`  ${desc}`)
      } catch (e) {
        console.log(`第 ${i} 次：❌ ${((Date.now() - t0) / 1000).toFixed(1)}s  ${e.message}`)
      }
    }
    console.log('\n（这条描述会被 buildImageContextNote 包成内部备注塞进系统提示词，')
    console.log(' 再由对话模型写人设回复 —— 那段是本地拼接，不额外耗时。）')
    console.log(buildImageContextNote('（示例）' + '这是一张表情包').slice(0, 120) + '…')
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
setTimeout(() => process.exit(2), 180000)
