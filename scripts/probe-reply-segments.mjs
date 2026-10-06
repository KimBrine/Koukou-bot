/**
 * 探针：群消息历史里到底有没有"回复/引用"信息，以及 parseMessage 能否取到 replyId。
 *   node scripts/probe-reply-segments.mjs <群号> [条数]
 * 只读，不发任何消息。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || 1121936348)
const count = Math.max(20, Math.min(500, Number(process.argv[3]) || 200))

onebot.on('ready', async () => {
  try {
    const res = await onebot.getGroupMsgHistory(group, null, 20000, count)
    const list = res?.messages || []
    console.log(`拉到 ${list.length} 条历史（群 ${group}）`)

    const typeCount = new Map()
    let withReplySeg = 0
    let withReplyId = 0
    const samples = []

    for (const m of list) {
      const raw = m.message ?? m.raw_message
      if (Array.isArray(raw)) {
        for (const seg of raw) {
          const t = seg?.type ?? '?'
          typeCount.set(t, (typeCount.get(t) || 0) + 1)
          if (t === 'reply') {
            withReplySeg++
            if (samples.length < 3) samples.push({ seg, id: m.message_id })
          }
        }
      } else if (typeof raw === 'string') {
        if (/\[CQ:reply/.test(raw)) withReplySeg++
      }
      const p = parseMessage(raw, null)
      if (p.replyId) withReplyId++
    }

    console.log('\n段类型统计：')
    for (const [t, n] of [...typeCount.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t}: ${n}`)
    }
    console.log(`\n含 reply 段的消息：${withReplySeg}`)
    console.log(`parseMessage 能取到 replyId 的消息：${withReplyId}`)
    console.log(`消息格式：${Array.isArray(list[0]?.message) ? 'array（段数组）' : typeof list[0]?.message}`)
    if (samples.length > 0) {
      console.log('\nreply 段样例：')
      for (const s of samples) console.log(`  message_id=${s.id} → ${JSON.stringify(s.seg)}`)
    } else {
      console.log('\n（没有找到 reply 段）')
    }
  } catch (err) {
    console.error('失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})

onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 60000)
