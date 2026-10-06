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
const fmt = (msgs) => {
  if (!msgs || msgs.length === 0) return 'count=0'
  const times = msgs.map((m) => Number(m.time) || 0).filter(Boolean)
  return `count=${msgs.length} timeRange=[${new Date(Math.min(...times) * 1000).toLocaleTimeString('zh-CN')}..${new Date(Math.max(...times) * 1000).toLocaleTimeString('zh-CN')}]`
}
ws.onopen = async () => {
  try {
    for (const count of [200, 500]) {
      const p = await call('get_group_msg_history', { group_id: 801944160, count })
      console.log(`count=${count} :`, fmt(p.messages))
    }
    process.exit(0)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(1)
  }
}
setTimeout(() => process.exit(2), 60000)
