const ws = new WebSocket('ws://127.0.0.1:3001')
let seq = 0
const pending = new Map()
function call(action, params, timeout = 15000) {
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
ws.onopen = async () => {
  try {
    // NapCat 私聊历史接口（非标准，NapCat 支持）
    const res = await call('get_friend_msg_history', { user_id: 1822939642, count: 20 })
    const msgs = res.messages || []
    console.log(`私聊历史 ${msgs.length} 条`)
    for (const m of msgs.slice(-8)) {
      const desc = Array.isArray(m.message)
        ? m.message.map((s) => (s.type === 'image' ? `[图片 url=${String(s.data?.url || '').slice(0, 100)} file=${String(s.data?.file || '').slice(0, 60)}]` : `[${s.type}]`)).join(' ')
        : String(m.message).slice(0, 120)
      console.log(`${m.time} ${m.sender?.nickname || m.user_id}: ${desc}`)
    }
    process.exit(0)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(1)
  }
}
setTimeout(() => process.exit(2), 40000)
