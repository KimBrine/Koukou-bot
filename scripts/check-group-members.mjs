import { getProbeTarget } from './probe-settings.mjs'
const ws = new WebSocket('ws://127.0.0.1:3001')
let seq = 0
const pending = new Map()
function call(action, params, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const echo = String(++seq)
    const t = setTimeout(() => { pending.delete(echo); reject(new Error('timeout')) }, timeout)
    pending.set(echo, { resolve, reject, t })
    ws.send(JSON.stringify({ action, params, echo }))
  })
}
ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data)
  if (d.echo !== undefined && pending.has(d.echo)) {
    const p = pending.get(d.echo)
    pending.delete(d.echo)
    clearTimeout(p.t)
    d.status === 'ok' ? p.resolve(d.data) : p.reject(new Error(d.message || d.retcode))
  }
}
const GID = getProbeTarget('group')
ws.onopen = async () => {
  console.log(`=== 群 ${GID} 成员列表 ===`)
  const members = await call('get_group_member_list', { group_id: GID })
  const list = Array.isArray(members) ? members : members?.group_member_list || []
  console.log(`共 ${list.length} 人：`)
  for (const m of list) {
    const isTarget = String(m.user_id) === '200000004'
    console.log(`  ${isTarget ? '👉' : '  '} QQ ${m.user_id} | 昵称「${m.nickname}」 | 群名片「${m.card || '（无）'}」 | 角色 ${m.role}`)
  }

  console.log(`\n=== 最近的发言者统计（群 ${GID} 历史前 200 条）===`)
  const hist = await call('get_group_msg_history', { group_id: GID, count: 200 })
  const msgs = (hist.messages || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0))
  const stat = new Map()
  for (const m of msgs) {
    const uid = String(m.user_id)
    const name = m.sender?.card || m.sender?.nickname || uid
    if (!stat.has(uid)) stat.set(uid, { name, count: 0, last: 0 })
    const s = stat.get(uid)
    s.count++
    s.last = Math.max(s.last, Number(m.time) || 0)
  }
  console.log(`历史 ${msgs.length} 条，来自 ${stat.size} 个用户：`)
  for (const [uid, s] of [...stat.entries()].sort((a, b) => b[1].last - a[1].last)) {
    const mark = uid === '200000004' ? ' 👈 目标用户' : ''
    console.log(`  QQ ${uid} | ${s.name} | ${s.count} 条 | 最后发言 ${new Date(s.last * 1000).toLocaleTimeString('zh-CN')}${mark}`)
  }
  process.exit(0)
}
setTimeout(() => process.exit(2), 90000)
