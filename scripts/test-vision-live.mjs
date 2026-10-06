import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const KEY = repoLocalConfig.dashscopeApiKey
const ws = new WebSocket('ws://127.0.0.1:3001')

let done = false
function finish(code) {
  if (done) return
  done = true
  try { ws.close() } catch { /* ignore */ }
  process.exit(code)
}

ws.onmessage = (ev) => {
  if (done) return
  let d
  try { d = JSON.parse(ev.data) } catch { return }
  if (d.post_type !== 'message' || !Array.isArray(d.message)) return
  const img = d.message.find((s) => s.type === 'image')
  if (!img || !img.data || !img.data.url) return
  console.log('抓到图片消息:', JSON.stringify({
    url: String(img.data.url).slice(0, 140),
    file: String(img.data.file || '').slice(0, 80),
  }))
  const url = img.data.url
  fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
    .then(async (r) => {
      console.log('图片下载 HTTP', r.status, 'type', r.headers.get('content-type'), 'len', r.headers.get('content-length'))
      if (!r.ok) return finish(3)
      const buf = Buffer.from(await r.arrayBuffer())
      console.log('实际字节数:', buf.length)
      const mime = buf[0] === 0xff ? 'image/jpeg' : buf[0] === 0x89 ? 'image/png' : 'image/gif'
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
      finish(res2.ok ? 0 : 4)
    })
    .catch((e) => {
      console.error('下载失败:', e.message)
      finish(5)
    })
}

ws.onerror = (e) => console.error('ws error')
setTimeout(() => {
  console.log('90 秒内没有抓到带图片的消息')
  finish(2)
}, 90000)
