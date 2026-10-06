import { getProbeTarget } from './probe-settings.mjs'
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
ws.onopen = async () => {
  const hist = await call('get_group_msg_history', { group_id: getProbeTarget('group'), count: 20 })
  const msgs = (hist.messages || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0))
  console.log('=== 机器人最近发出的消息及其消息段 ===')
  const botMsgs = msgs.filter((m) => String(m.user_id) === '200000014').slice(-4)
  for (const m of botMsgs) {
    const segs = Array.isArray(m.message)
      ? m.message.map((s) => {
          if (s.type === 'text') return `text(${JSON.stringify(String(s.data?.text || '').slice(0, 30))})`
          if (s.type === 'face') return `face(id=${s.data?.id} 名称=${s.data?.raw?.faceText || '-'})`
          if (s.type === 'at') return `at(${s.data?.qq})`
          return s.type
        }).join(' + ')
      : String(m.message).slice(0, 50)
    const t = new Date(Number(m.time) * 1000).toLocaleTimeString('zh-CN')
    console.log(`[${t}] ${segs}`)
  }
  const hasFace = botMsgs.some((m) => Array.isArray(m.message) && m.message.some((s) => s.type === 'face'))
  const hasLiteral = botMsgs.some((m) => Array.isArray(m.message) && m.message.some((s) => s.type === 'text' && /\[表情[:：]/.test(String(s.data?.text || ''))))
  console.log('\n结论：')
  console.log(`  包含真实表情段(face)：${hasFace ? '✅ 是' : '否'}`)
  console.log(`  仍含字面量 [表情:xx]：${hasLiteral ? '❌ 是（转换没生效）' : '✅ 否'}`)
  process.exit(0)
}
setTimeout(() => process.exit(2), 60000)
