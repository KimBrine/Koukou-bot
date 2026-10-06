/**
 * 群聊报告实测脚本。
 *
 *   node scripts/test-summary.mjs <群号> [天数] [dry|forward|split|ping]
 *
 *   dry    （默认）只生成并打印报告，不发送
 *   forward 生成后用「合并转发」打包发送
 *   split   生成后按空行逐条发送
 *   ping    只发一张 3 条的合并转发测试卡片，用来单独验证 send_group_forward_msg 是否可用
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { DeepSeekClient } from '../src/deepseek.js'
import { OneBotClient } from '../src/onebot.js'
import { createDailySummary, buildSummaryPrompt } from '../src/dailySummary.js'
import { formatUserTable } from '../src/summaryStats.js'

const config = loadConfig()
const logger = createLogger('info', null)
const mode = String(process.argv[4] || 'dry').toLowerCase()
if (mode === 'forward' || mode === 'split') config.summarySendMode = mode

const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const useQwen = config.summaryProvider === 'dashscope'
const llm = new DeepSeekClient({
  apiKey: useQwen ? config.dashscopeApiKey : config.deepseekApiKey,
  baseUrl: useQwen ? config.dashscopeBaseUrl : config.deepseekBaseUrl,
  model: config.summaryModel || config.deepseekModel,
  temperature: 1.0,
  maxTokens: config.summaryMaxTokens,
  timeoutMs: 180000,
  maxRetries: 1,
  maxConcurrency: 1,
  logger,
  label: useQwen ? '报告模型(通义千问)' : '报告模型(DeepSeek)',
})
// 与 index.js 保持同一份提示词拼法
const summaryPromptFn = (opts) => {
  const personaPart = config.persona
    ? `${config.persona}\n\n（注意：现在是在写「群聊日常分析报告」，不是日常聊天——上面人设里"一两句话、别长篇大论、回复长度跟着对方走"等聊天规则不适用于报告场景，口吻和语气保持一致即可，篇幅与格式以下面的报告要求为准。）\n\n`
    : ''
  return `${personaPart}${buildSummaryPrompt(opts)}`
}
const daily = createDailySummary({ config, logger, onebot, llm, buildSummaryPromptFn: summaryPromptFn })

onebot.on('ready', async () => {
  const group = Number(process.argv[2] || 801944160)
  const days = Math.max(1, Math.min(30, Number(process.argv[3]) || 1))
  console.log(`== 模式 ${mode}｜群 ${group}｜最近 ${days} 天 ==`)
  try {
    if (mode === 'ping') {
      console.log('发送 3 条合并转发测试卡片…')
      const res = await onebot.sendGroupForward(group, [
        { text: '🎯 合并转发格式自检\n📅 测试' },
        { text: '📊 基础统计\n• 消息总数: 1\n• 参与人数: 1\n• 总字符数: 1\n• 表情数量: 0\n• 最活跃时段: 00:00-01:00' },
        { text: '💬 第二块\n如果这张卡片能正常展开显示，说明合并转发可用。' },
      ])
      console.log('✅ 合并转发发送成功：', JSON.stringify(res))
    } else if (mode === 'stats') {
      // 不调模型，只核对统计口径（排查"回复比例全 0"这类数据问题用）
      const { records, stats } = await daily.previewStats(group, days)
      console.log(`\n参与统计的消息：${records.length} 条｜含 replyId（回复别人的）：${records.filter((r) => r.replyId).length} 条`)
      console.log(`📊 基础统计\n• 消息总数: ${stats.total}\n• 参与人数: ${stats.people}\n• 总字符数: ${stats.chars}\n• 表情数量: ${stats.emoji}\n• 最活跃时段: ${stats.peak}`)
      console.log('\n每人数据（喂给模型的就是这张表）：')
      console.log(formatUserTable(stats, { limit: config.summaryUserRows }))
    } else {
      await daily.runSummary(group, { dryRun: mode === 'dry', days })
      console.log('== 完成 ==')
    }
  } catch (e) {
    console.error('失败:', e?.message || e)
  }
  onebot.stop()
  process.exit(0)
})

onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => {
  console.error('全局超时')
  process.exit(2)
}, 300000)
