import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const QW_KEY = repoLocalConfig.dashscopeApiKey
const ws = new WebSocket('ws://127.0.0.1:3001')
let seq = 0
const pending = new Map()

function call(action, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const echo = String(++seq)
    const t = setTimeout(() => { pending.delete(echo); reject(new Error(`timeout ${action}`)) }, timeout)
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
    d.status === 'ok' ? p.resolve(d.data) : p.reject(new Error(d.message || `retcode ${d.retcode}`))
  }
}

ws.onopen = async () => {
  try {
    const hist = await call('get_group_msg_history', { group_id: 801944160, count: 60 })
    let target = null
    for (const m of hist.messages || []) {
      if (Array.isArray(m.message)) {
        const img = m.message.find((s) => s.type === 'image' && s.data && s.data.url)
        if (img) { target = img.data.url; break }
      }
    }
    if (!target) { console.log('没找到图片'); process.exit(2) }
    const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    console.log('图片下载 HTTP', r.status, r.headers.get('content-type'))
    const buf = Buffer.from(await r.arrayBuffer())
    const mime = buf[0] === 0xff ? 'image/jpeg' : buf[0] === 0x89 ? 'image/png' : 'image/gif'
    const res2 = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${QW_KEY}` },
      body: JSON.stringify({
        model: 'qwen3.7-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这张图是什么？用一句话吐槽一下' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
          ],
        }],
        max_tokens: 200,
      }),
    })
    const t = await res2.text()
    console.log('qwen3.7-flash 识图 HTTP', res2.status)
    console.log(t.slice(0, 400))
    process.exit(res2.ok ? 0 : 4)
  } catch (e) {
    console.error('流程失败:', e.message)
    process.exit(5)
  }
}
setTimeout(() => { console.error('全局超时'); process.exit(6) }, 60000)
