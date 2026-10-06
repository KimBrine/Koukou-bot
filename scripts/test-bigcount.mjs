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
const fmt = (msgs) => {
  if (!msgs || msgs.length === 0) return 'count=0'
  const times = msgs.map((m) => Number(m.time) || 0).filter(Boolean)
  const min = new Date(Math.min(...times) * 1000)
  const max = new Date(Math.max(...times) * 1000)
  const span = ((Math.max(...times) - Math.min(...times)) / 3600).toFixed(1)
  return `count=${msgs.length} 时间跨度=[${min.toLocaleString('zh-CN')} ~ ${max.toLocaleString('zh-CN')}] 约 ${span} 小时`
}
ws.onopen = async () => {
  for (const count of [500, 1000, 2000, 5000]) {
    try {
      const t0 = Date.now()
      const res = await call('get_group_msg_history', { group_id: getProbeTarget('group'), count })
      console.log(`count=${String(count).padEnd(5)} → ${fmt(res.messages)}  (耗时 ${Date.now() - t0}ms)`)
    } catch (e) {
      console.log(`count=${String(count).padEnd(5)} → 失败: ${e.message}`)
    }
  }
  process.exit(0)
}
setTimeout(() => process.exit(2), 180000)
