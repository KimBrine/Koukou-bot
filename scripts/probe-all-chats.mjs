/**
 * 扫一遍机器人所在的所有群 + 好友会话，报告每个会话"最后一条消息距今多久"。
 * 用来判断"机器人不回复"到底是没消息、还是消息没进到机器人手里。
 *   node scripts/probe-all-chats.mjs
 * 只读，不发消息。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })

const ago = (sec) => {
  if (!sec) return '无记录'
  const m = (Date.now() - sec * 1000) / 60000
  if (m < 60) return `${m.toFixed(1)} 分钟前`
  if (m < 60 * 24) return `${(m / 60).toFixed(1)} 小时前`
  return `${(m / 1440).toFixed(1)} 天前`
}

onebot.on('ready', async () => {
  try {
    const rawGroups = await onebot.api('get_group_list', {}, 8000)
    const groups = Array.isArray(rawGroups) ? rawGroups : (rawGroups?.data ?? [])
    console.log(`机器人所在群：${groups.length} 个\n`)

    const rows = []
    for (const g of groups) {
      const gid = Number(g.group_id)
      let last = null
      let who = ''
      let text = ''
      let n = 0
      try {
        const res = await onebot.getGroupMsgHistory(gid, null, 12000, 5)
        const list = res?.messages || []
        n = list.length
        if (n > 0) {
          const m = list[n - 1]
          last = Number(m.time)
          who = m.sender?.card || m.sender?.nickname || m.user_id
          text = String(parseMessage(m.message ?? m.raw_message, null).text || '(非文本)').slice(0, 24)
        }
      } catch (err) {
        last = null
        text = `查询失败：${err.message}`
      }
      rows.push({ gid, name: g.group_name, members: g.member_count, last, who, text, n })
    }
    rows.sort((a, b) => (b.last ?? 0) - (a.last ?? 0))
    console.log('群名'.padEnd(26) + '最后一条'.padEnd(14) + '发言者 / 内容')
    for (const r of rows) {
      console.log(`${String(r.name ?? r.gid).padEnd(26)}${ago(r.last).padEnd(14)}${r.who ? r.who + '：' + r.text : r.text}`)
    }

    // 好友私聊
    try {
      const rawFriends = await onebot.api('get_friend_list', {}, 8000)
      const friends = Array.isArray(rawFriends) ? rawFriends : (rawFriends?.data ?? [])
      console.log(`\n好友：${friends.length} 个（只列最近有消息的）`)
      for (const f of friends.slice(0, 30)) {
        try {
          const res = await onebot.api('get_friend_msg_history', { user_id: Number(f.user_id), count: 3 }, 8000)
          const list = res?.messages ?? res?.data?.messages ?? []
          if (list.length > 0) {
            const m = list[list.length - 1]
            console.log(`  ${f.nickname ?? f.user_id}：${ago(Number(m.time))} — ${String(parseMessage(m.message ?? m.raw_message, null).text || '(非文本)').slice(0, 24)}`)
          }
        } catch {
          /* 单个人查不到就跳过 */
        }
      }
    } catch (err) {
      console.log(`  好友列表查询失败：${err.message}`)
    }

    // 待处理的加好友/进群请求
    try {
      const flags = await onebot.api('get_group_system_msg', {}, 6000)
      const invited = flags?.invited_requests?.length ?? 0
      const joinReq = flags?.join_requests?.length ?? 0
      if (invited || joinReq) console.log(`\n待处理请求：邀请 ${invited} 条、加群 ${joinReq} 条`)
    } catch {
      /* 不支持就算了 */
    }
  } catch (err) {
    console.error('扫描失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 120000)
