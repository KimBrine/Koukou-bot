import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const QW_KEY = repoLocalConfig.dashscopeApiKey
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
    // 找一张群历史里的真实图片
    const hist = await call('get_group_msg_history', { group_id: 801944160, count: 100 })
    let url = null
    for (const m of hist.messages || []) {
      if (Array.isArray(m.message)) {
        const img = m.message.find((s) => s.type === 'image' && s.data && s.data.url)
        if (img) { url = img.data.url; break }
      }
    }
    if (!url) { console.log('没找到图片'); process.exit(2) }
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    const buf = Buffer.from(await r.arrayBuffer())
    const mime = buf[0] === 0xff ? 'image/jpeg' : 'image/png'
    console.log('图片:', mime, buf.length, '字节')

    const system = '你是「小口口子」，一个可爱的群友。口语化回复，可以吐槽、接梗、发颜文字。'
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: '哈喽哇' },
      { role: 'assistant', content: '嗨嗨～在的哦awa' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
        ],
      },
    ]
    // 复现机器人参数
    const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${QW_KEY}` },
      body: JSON.stringify({ model: 'qwen3.7-flash', messages, temperature: 1.2, max_tokens: 500, stream: false }),
    })
    const t = await res.text()
    console.log('HTTP', res.status, '|', t.slice(0, 400))
    process.exit(res.ok ? 0 : 4)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(5)
  }
}
setTimeout(() => process.exit(6), 90000)
