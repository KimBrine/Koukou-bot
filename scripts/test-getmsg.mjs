import { getProbeTarget } from './probe-settings.mjs'
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
    const hist = await call('get_group_msg_history', { group_id: getProbeTarget('group'), count: 30 })
    const msgs = hist.messages || []
    console.log(`历史 ${msgs.length} 条，取最近一条测试 get_msg`)
    for (const m of msgs.slice(0, 3)) {
      const id = String(m.message_id)
      try {
        const got = await call('get_msg', { message_id: id })
        const text = Array.isArray(got.message)
          ? got.message.map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join('')
          : String(got.message)
        console.log(`✅ get_msg(${id}) → 发送者=${got.sender?.nickname || got.user_id} 内容=${JSON.stringify(text.slice(0, 40))}`)
      } catch (e) {
        console.log(`❌ get_msg(${id}) 失败: ${e.message}`)
      }
    }
    process.exit(0)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(1)
  }
}
setTimeout(() => process.exit(2), 60000)
