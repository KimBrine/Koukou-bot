import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const KEY = repoLocalConfig.dashscopeApiKey
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
    const msgs = hist.messages || []
    console.log(`历史消息 ${msgs.length} 条，找带图片的…`)
    let target = null
    for (const m of msgs) {
      const raw = m.message
      if (Array.isArray(raw)) {
        const img = raw.find((s) => s.type === 'image' && s.data && (s.data.url || s.data.file))
        if (img) { target = img.data; break }
      } else if (typeof raw === 'string' && /\[CQ:image,/.test(raw)) {
        const urlM = /url=([^,\]]+)/.exec(raw)
        if (urlM) { target = { url: urlM[1].replace(/&amp;/g, '&') }; break }
      }
    }
    if (!target) {
      console.log('历史里没找到带图片的消息')
      process.exit(2)
    }
    console.log('目标图片:', JSON.stringify({ url: String(target.url || '').slice(0, 140), file: String(target.file || '').slice(0, 80) }))

    let buf
    let mime
    if (target.url) {
      const r = await fetch(target.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
      console.log('图片下载 HTTP', r.status, 'type', r.headers.get('content-type'), 'len', r.headers.get('content-length'))
      if (!r.ok) { console.log('QQ CDN 直连失败，尝试 get_image 接口'); throw new Error('cdn fail') }
      buf = Buffer.from(await r.arrayBuffer())
      mime = buf[0] === 0xff ? 'image/jpeg' : buf[0] === 0x89 ? 'image/png' : 'image/gif'
    } else {
      const got = await call('get_image', { file: target.file })
      console.log('get_image 返回:', JSON.stringify(got).slice(0, 200))
      if (got.url) {
        const r = await fetch(got.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        buf = Buffer.from(await r.arrayBuffer())
      } else if (got.file) {
        const { readFileSync } = await import('node:fs')
        buf = readFileSync(got.file)
      }
      mime = buf && buf[0] === 0xff ? 'image/jpeg' : buf && buf[0] === 0x89 ? 'image/png' : 'image/gif'
    }
    console.log('实际字节数:', buf.length)
    const res2 = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'qwen-vl-plus',
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
    console.log('视觉识别 HTTP', res2.status)
    console.log(t.slice(0, 400))
    process.exit(res2.ok ? 0 : 4)
  } catch (e) {
    console.error('流程失败:', e.message)
    process.exit(5)
  }
}
setTimeout(() => { console.error('全局超时'); process.exit(6) }, 60000)
