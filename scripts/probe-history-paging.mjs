import { getProbeTarget } from './probe-settings.mjs'
/**
 * 验证 NapCat 的群历史接口：一次请求能拿回多少？能不能用 message_seq 翻页拿更早的？
 * 这决定了"群总结只能拿到 42 条"是不是接口限制、以及能不能修。
 *
 *   node scripts/probe-history-paging.mjs [群号]
 *
 * **只读，不发消息。**
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || getProbeTarget('group'))

onebot.on('ready', async () => {
  try {
    console.log(`群 ${group}\n`)

    // ① 一次要 300 条，看实际给多少
    const r1 = await onebot.getGroupMsgHistory(group, null, 20000, 300)
    const m1 = r1?.messages || []
    console.log(`① 一次请求 count=300 → 实际返回 ${m1.length} 条`)
    if (m1.length) {
      const t0 = Number(m1[0].time) * 1000
      const t1 = Number(m1[m1.length - 1].time) * 1000
      const f = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false })
      console.log(`   时间范围: ${f(t0)}  →  ${f(t1)}`)
      console.log(`   跨度: ${((t1 - t0) / 60000).toFixed(1)} 分钟`)
    }

    // ② 用 message_seq 往前翻页，最多翻 5 页，看能不能拿到更早的
    let seq = m1.length ? m1[0].message_seq : null
    const all = [...m1]
    let page = 0
    while (seq && page < 5) {
      page++
      const r = await onebot.getGroupMsgHistory(group, seq, 20000, 300)
      const ms = r?.messages || []
      // NapCat 返回的第一条通常就是游标那条本身，去重靠 message_id
      const fresh = ms.filter((x) => !all.some((y) => String(y.message_id) === String(x.message_id)))
      console.log(`② 第 ${page} 页（cursor=${seq}）→ 返回 ${ms.length} 条，其中新的 ${fresh.length} 条`)
      if (fresh.length === 0) break
      all.unshift(...fresh)
      seq = fresh[0].message_seq
    }

    if (all.length) {
      const t0 = Number(all[0].time) * 1000
      const t1 = Number(all[all.length - 1].time) * 1000
      const f = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false })
      console.log(`\n合计拿到 ${all.length} 条，覆盖 ${f(t0)} → ${f(t1)}（${((t1 - t0) / 3600000).toFixed(1)} 小时）`)
      // 按今天 0 点起算，看能覆盖今天多少条
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const today = all.filter((m) => Number(m.time) * 1000 >= dayStart.getTime())
      console.log(`其中属于今天(0 点起)的: ${today.length} 条`)
    }
  } catch (err) {
    console.error('探测失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 120000)
