const ws = new WebSocket('ws://127.0.0.1:3001')
let seq = 0
const pending = new Map()
function call(action, params, timeout = 20000) {
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
const hhmm = (t) => new Date(t * 1000).toLocaleTimeString('zh-CN')

ws.onopen = async () => {
  const hist = await call('get_group_msg_history', { group_id: 794601094, count: 400 })
  const msgs = (hist.messages || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0))
  console.log(`共 ${msgs.length} 条历史，筛选 08:44:30 ~ 08:46:30 区间\n`)
  for (const m of msgs) {
    const t = Number(m.time) || 0
    const d = new Date(t * 1000)
    const hh = d.getHours()
    const mm = d.getMinutes()
    const ss = d.getSeconds()
    if (hh !== 8 || mm < 44 || (mm === 44 && ss < 30) || mm > 46 || (mm === 46 && ss > 30)) continue
    const name = m.sender?.card || m.sender?.nickname || m.user_id
    const segs = Array.isArray(m.message)
      ? m.message.map((s) => {
          if (s.type === 'text') return `text(${JSON.stringify(String(s.data?.text || '').slice(0, 30))})`
          if (s.type === 'image') return `image(file=${String(s.data?.file || '').slice(0, 18)} hasUrl=${!!s.data?.url})`
          if (s.type === 'face') return `face(id=${s.data?.id},name=${s.data?.raw?.faceText || '-'})`
          if (s.type === 'at') return `at(${s.data?.qq})`
          if (s.type === 'reply') return `reply(id=${s.data?.id})`
          return s.type
        })
      : String(m.message).slice(0, 50)
    console.log(`[${hhmm(t)}] ${name} (id=${m.message_id}): ${segs.join(' + ')}`)
    const replySeg = Array.isArray(m.message) ? m.message.find((s) => s.type === 'reply') : null
    if (replySeg) {
      try {
        const q = await call('get_msg', { message_id: String(replySeg.data.id) })
        const qsegs = Array.isArray(q.message)
          ? q.message.map((s) => (s.type === 'image' ? `image(hasUrl=${!!s.data?.url})` : s.type === 'text' ? `text(${JSON.stringify(String(s.data?.text || '').slice(0, 24))})` : s.type)).join(' + ')
          : String(q.message).slice(0, 40)
        console.log(`      ↳ 引用内容: ${qsegs}`)
      } catch (e) {
        console.log(`      ↳ 引用取回失败: ${e.message}`)
      }
    }
  }
  process.exit(0)
}
setTimeout(() => process.exit(2), 120000)
