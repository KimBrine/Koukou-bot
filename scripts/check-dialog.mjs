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
const GID = 1121936348
const TARGET = '1279630177'
const BOT = '3883059067'

ws.onopen = async () => {
  const hist = await call('get_group_msg_history', { group_id: GID, count: 200 })
  const msgs = (hist.messages || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0))
  const recent = msgs.filter((m) => Number(m.time) >= Math.floor(Date.now() / 1000) - 3600)
  console.log(`=== 群 ${GID} 最近一小时消息（${recent.length} 条）===\n`)
  for (const m of recent) {
    const uid = String(m.user_id)
    const name = m.sender?.card || m.sender?.nickname || uid
    const mark = uid === TARGET ? '🐟' : uid === BOT ? '🤖' : '  '
    const text = Array.isArray(m.message)
      ? m.message.map((s) => (s.type === 'text' ? s.data.text : s.type === 'image' ? '[图片]' : s.type === 'poke' ? '[拍一拍]' : `[${s.type}]`)).join('')
      : String(m.message).slice(0, 60)
    const d = new Date(Number(m.time) * 1000)
    console.log(`${mark} [${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}] ${name}: ${String(text).slice(0, 60)}`)
  }
  console.log('\n=== 服务器时间 vs 本地时间 ===')
  const last = recent[recent.length - 1]
  if (last) {
    console.log(`最后一条消息服务器时间: ${new Date(Number(last.time) * 1000).toLocaleString('zh-CN')}`)
    console.log(`本地时间:                 ${new Date().toLocaleString('zh-CN')}`)
    console.log(`偏差（服务器 - 本地）: ${(Number(last.time) * 1000 - Date.now()) / 1000} 秒`)
  }
  process.exit(0)
}
setTimeout(() => process.exit(2), 90000)
