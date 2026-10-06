/**
 * 手动触发一次「定时指令」（默认就是每天 00:00 在示例群 A @示例机器人 发 /今日猪猪 的那条）。
 *   node scripts/test-daily-ping.mjs          # 真发一条
 *   node scripts/test-daily-ping.mjs --dry     # 只打印将要发送的内容，不发送
 *
 * 走的是线上同一份 createDailyPing 代码，避免"测试和线上不是一套逻辑"。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { createRateLimiter } from '../src/humanize.js'
import { createDailyPing } from '../src/dailyPing.js'

const dry = process.argv.includes('--dry')
const config = loadConfig()
const logger = createLogger('info', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const rateLimiter = createRateLimiter({ perHour: config.rateLimitPerHour, minGapMs: config.rateLimitMinGapMs })
const dailyPing = createDailyPing({ config, logger, onebot, rateLimiter })

console.log(`=== 定时指令自测 ===`)
console.log(`  配置：${dailyPing.describe()}`)
const group = config.dailyPingGroup
const target = config.dailyPingTarget
const text = config.dailyPingText
console.log(`  将要发送：群 ${group} → 「@${target}（示例机器人） ${text}」（@ 是真实 at 段，对方会收到提醒）`)

if (dry) {
  console.log('  （--dry 模式，不实际发送）')
  process.exit(0)
}

onebot.on('ready', async () => {
  const ok = await dailyPing.sendNow('手动自测')
  console.log(ok ? '  ✅ 已发送' : '  ❌ 发送失败（见上面的日志）')
  onebot.stop()
  process.exit(ok ? 0 : 1)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 40000)
