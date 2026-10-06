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
const fmt = (msgs) => {
  const seqs = msgs.map((m) => m.message_seq)
  const times = msgs.map((m) => m.time).filter(Boolean)
  return `count=${msgs.length} seqRange=[${Math.min(...seqs)}..${Math.max(...seqs)}] timeRange=[${times.length ? new Date(Math.min(...times) * 1000).toLocaleTimeString('zh-CN') : '?'}..${times.length ? new Date(Math.max(...times) * 1000).toLocaleTimeString('zh-CN') : '?'}] firstSeq=${seqs[0]}`
}
ws.onopen = async () => {
  try {
    const p1 = await call('get_group_msg_history', { group_id: 801944160 })
    console.log('无 seq        :', fmt(p1.messages))
    const minSeq = Math.min(...p1.messages.map((m) => m.message_seq))
    const p2 = await call('get_group_msg_history', { group_id: 801944160, message_seq: minSeq })
    console.log('seq=minSeq    :', fmt(p2.messages))
    const p3 = await call('get_group_msg_history', { group_id: 801944160, message_seq: minSeq - 1 })
    console.log('seq=minSeq-1  :', fmt(p3.messages))
    process.exit(0)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(1)
  }
}
setTimeout(() => process.exit(2), 60000)
