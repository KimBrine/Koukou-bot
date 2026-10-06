import { getProbeTarget } from './probe-settings.mjs'
/**
 * 复现"群总结只拿到 42 条"：按 runSummary 的完全相同步骤取数，把每一步的数量都打出来，
 * 定位到底在哪一步丢的。
 *
 *   node scripts/probe-summary-count.mjs [群号] [天数]
 *
 * **只读 + 只调统计，不调模型、不发消息。**
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'
import { createDailySummary } from '../src/dailySummary.js'

const config = loadConfig()
const logger = createLogger('info', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || getProbeTarget('group'))
const days = Math.max(1, Math.min(30, Number(process.argv[3]) || 1))

onebot.on('ready', async () => {
  try {
    const ds = createDailySummary({ config, logger, onebot, llm: null })
    // ① 捕获文件里有多少（重启也不丢的那部分）
    const capturedCount = ds.countCaptured(group, days)
    console.log(`① 实时捕获记录（data/daily 落盘）: ${capturedCount} 条`)

    // ② 历史回填（和 runSummary 一样的调用方式；超时给足，历史接口实测要十几秒）
    const t0 = Date.now()
    const reqCount = Math.min(500, Math.max(200, days * 300))
    const raw = await onebot.getGroupMsgHistory(group, null, 60000, reqCount)
    const msgs = raw?.messages || []
    console.log(`② NapCat 历史接口: 请求 ${reqCount} 条 → 返回 ${msgs.length} 条（耗时 ${Date.now() - t0}ms）`)

    // ③ 走完整的 previewStats（= runSummary 的取数与合并逻辑）
    const t1 = Date.now()
    const { records, stats } = await ds.previewStats(group, days)
    console.log(`③ previewStats 合并后: ${records.length} 条（耗时 ${Date.now() - t1}ms）`)
    console.log(`   统计: ${stats.total} 条 / ${stats.people} 人 / ${stats.chars} 字 / 表情 ${stats.emoji}`)

    if (records.length) {
      const f = (t) => new Date(t * 1000).toLocaleString('zh-CN', { hour12: false })
      console.log(`   覆盖时间: ${f(records[0].time)} → ${f(records[records.length - 1].time)}`)
      // 按小时分布，看是不是只覆盖了最近一小段
      const byHour = new Map()
      for (const r of records) {
        const h = new Date(r.time * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit' })
        byHour.set(h, (byHour.get(h) || 0) + 1)
      }
      console.log('   按小时分布:')
      for (const [h, n] of [...byHour.entries()].sort()) console.log(`      ${h}  ${n} 条`)
    }

    // ④ 直接比对：历史接口里属于今天(或近 N 天)的有多少条
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - (days - 1))
    const startSec = Math.floor(start.getTime() / 1000)
    const inWindow = msgs.filter((m) => Number(m.time) >= startSec && String(m.user_id) !== String(onebot.selfId))
    console.log(`④ 历史接口返回的原始数据里，落在时间窗内的群友消息: ${inWindow.length} 条`)
    console.log(`   → 与 ③ 的差值 = ${inWindow.length - records.length} 条（差值大说明合并/去重有问题）`)
  } catch (err) {
    console.error('探测失败:', err.stack || err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 120000)
