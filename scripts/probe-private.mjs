/**
 * 私聊诊断：好友列表、指定用户的私聊历史、以及机器人账号自身状态。
 *   node scripts/probe-private.mjs [QQ号]
 * 只读，不发消息。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const target = String(process.argv[2] || '1822939642')

const fmt = (sec) => (sec ? new Date(Number(sec) * 1000).toLocaleString('zh-CN', { hour12: false }) : '—')

onebot.on('ready', async () => {
  console.log(`机器人账号：${onebot.nickname}（${onebot.selfId}）\n`)

  // 1) 好友列表
  try {
    const raw = await onebot.api('get_friend_list', {}, 8000)
    const friends = Array.isArray(raw) ? raw : (raw?.data ?? [])
    console.log(`好友列表：${friends.length} 个`)
    for (const f of friends.slice(0, 20)) console.log(`  ${f.user_id}  ${f.nickname ?? ''}  ${f.remark ?? ''}`)
    console.log(`  目标 ${target} 在好友列表里：${friends.some((f) => String(f.user_id) === target) ? '是 ✅' : '否 ❌（非好友只能用临时会话）'}`)
  } catch (err) {
    console.log(`好友列表查询失败：${err.message}`)
  }

  // 2) 该用户的私聊历史
  for (const action of ['get_friend_msg_history', 'get_friend_msg_history']) {
    try {
      const res = await onebot.api(action, { user_id: Number(target), count: 10 }, 12000)
      const list = res?.messages ?? res?.data?.messages ?? []
      console.log(`\n私聊历史（${action}）：${list.length} 条`)
      for (const m of list.slice(-8)) {
        const p = parseMessage(m.message ?? m.raw_message, String(onebot.selfId))
        const dir = String(m.user_id) === String(onebot.selfId) ? '机器人→' : '对方→  '
        console.log(`  ${fmt(m.time)}  ${dir} ${String(p.text || '(非文本)').slice(0, 40)}`)
      }
      break
    } catch (err) {
      console.log(`私聊历史查询失败（${action}）：${err.message}`)
      break
    }
  }

  // 3) 未读 / 最近会话
  try {
    const res = await onebot.api('get_recent_contact', { count: 10 }, 8000)
    const list = res?.data ?? res ?? []
    if (Array.isArray(list) && list.length) {
      console.log(`\n最近会话（${list.length} 条）：`)
      for (const c of list.slice(0, 8)) {
        console.log(`  ${c.peerUin ?? c.user_id ?? '?'}  ${c.msgTime ? fmt(c.msgTime) : ''}  ${String(c.lastestMsg ?? c.lastMsg ?? '').slice(0, 30)}`)
      }
    }
  } catch (err) {
    console.log(`\n最近会话查询不可用（${err.message}）`)
  }

  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 60000)
