/**
 * 问 NapCat：某个群最近到底有没有新消息（与机器人自己收没收到做对照）。
 *   node scripts/probe-group-activity.mjs [群号] [条数]
 * 只读，不发消息。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || 1121936348)
const count = Math.max(5, Math.min(100, Number(process.argv[3]) || 20))

onebot.on('ready', async () => {
  try {
    const res = await onebot.getGroupMsgHistory(group, null, 20000, count)
    const list = res?.messages || []
    console.log(`群 ${group} 最近 ${list.length} 条（来自 NapCat）:`)
    for (const m of list.slice(-12)) {
      const p = parseMessage(m.message ?? m.raw_message, null)
      const t = new Date(Number(m.time) * 1000).toLocaleString('zh-CN', { hour12: false })
      const who = m.sender?.card || m.sender?.nickname || m.user_id
      console.log(`  ${t}  ${who}：${String(p.text || '(非文本)').slice(0, 40)}`)
    }
    const newest = list.length > 0 ? Number(list[list.length - 1].time) * 1000 : 0
    if (newest) {
      const mins = ((Date.now() - newest) / 60000).toFixed(1)
      console.log(`\n最新一条距今 ${mins} 分钟`)
    }
  } catch (err) {
    console.error('查询失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 45000)
