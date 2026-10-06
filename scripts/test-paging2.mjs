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
const info = (msgs) => {
  if (!msgs || !msgs.length) return 'count=0'
  const times = msgs.map((m) => Number(m.time) || 0).filter(Boolean)
  const seqs = msgs.map((m) => Number(m.message_seq) || 0)
  return `count=${msgs.length} 时间=[${new Date(Math.min(...times) * 1000).toLocaleString('zh-CN')} ~ ${new Date(Math.max(...times) * 1000).toLocaleString('zh-CN')}] seq=[${Math.min(...seqs)} ~ ${Math.max(...seqs)}]`
}
ws.onopen = async () => {
  try {
    const p1 = await call('get_group_msg_history', { group_id: getProbeTarget('group'), count: 300 })
    console.log('第1页(无seq)      :', info(p1.messages))
    const minSeq = Math.min(...p1.messages.map((m) => Number(m.message_seq) || Infinity))
    console.log(`最小 message_seq = ${minSeq}`)

    for (const [label, params] of [
      ['seq=minSeq      ', { message_seq: minSeq, count: 300 }],
      ['seq=minSeq-1    ', { message_seq: minSeq - 1, count: 300 }],
      ['seq=minSeq-180  ', { message_seq: minSeq - 180, count: 300 }],
    ]) {
      try {
        const r = await call('get_group_msg_history', { group_id: getProbeTarget('group'), ...params })
        console.log(`第2页(${label}) :`, info(r.messages))
      } catch (e) {
        console.log(`第2页(${label}) : 失败 ${e.message}`)
      }
    }
    process.exit(0)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(1)
  }
}
setTimeout(() => process.exit(2), 180000)
