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
  const faces = []
  for (const gid of [200000018, 200000019, 200000017]) {
    try {
      const res = await call('get_group_msg_history', { group_id: gid, count: 200 })
      for (const m of res.messages || []) {
        if (!Array.isArray(m.message)) continue
        for (const seg of m.message) {
          if (seg.type === 'face') faces.push(seg)
        }
      }
    } catch (e) {
      console.log(`群 ${gid} 拉取失败: ${e.message}`)
    }
  }
  console.log(`共找到 ${faces.length} 个 face 表情段`)
  const seen = new Set()
  for (const f of faces) {
    const key = JSON.stringify(f)
    if (seen.has(key)) continue
    seen.add(key)
    console.log(JSON.stringify(f))
    if (seen.size >= 12) break
  }
  process.exit(0)
}
setTimeout(() => process.exit(2), 60000)
