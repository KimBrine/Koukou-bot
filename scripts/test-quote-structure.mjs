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
  const hist = await call('get_group_msg_history', { group_id: 794601094, count: 60 })
  const msgs = hist.messages || []
  console.log(`历史 ${msgs.length} 条\n`)
  let checked = 0
  for (const m of msgs) {
    if (!Array.isArray(m.message)) continue
    const replySeg = m.message.find((s) => s.type === 'reply')
    if (!replySeg) continue
    const qid = String(replySeg.data?.id || '')
    const ownTypes = m.message.map((s) => s.type).join(',')
    let quotedInfo = '（取不到）'
    try {
      const q = await call('get_msg', { message_id: qid })
      const qTypes = Array.isArray(q.message) ? q.message.map((s) => s.type).join(',') : typeof q.message
      const qText = Array.isArray(q.message)
        ? q.message.map((s) => (s.type === 'text' ? s.data.text : s.type === 'image' ? `[img file=${String(s.data?.file || '').slice(0, 20)} url=${String(s.data?.url || '').slice(0, 30)}]` : `[${s.type}]`)).join('')
        : String(q.message).slice(0, 60)
      quotedInfo = `segments=[${qTypes}] 内容=${JSON.stringify(qText.slice(0, 90))}`
    } catch (e) {
      quotedInfo = `失败: ${e.message}`
    }
    console.log(`消息(${ownTypes}) replyId=${qid}`)
    console.log(`   被引用 → ${quotedInfo}\n`)
    if (++checked >= 6) break
  }
  if (checked === 0) console.log('最近 60 条里没有引用消息')
  process.exit(0)
}
setTimeout(() => process.exit(2), 90000)
