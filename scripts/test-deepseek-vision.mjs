import { getProbeTarget } from './probe-settings.mjs'
import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DS_KEY = repoLocalConfig.deepseekApiKey
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const persona = readFileSync(path.join(root, 'persona.txt'), 'utf8').trim()
const time = new Date().toLocaleString('zh-CN', { hour12: false })
const system = `${persona}\n\n（系统附加说明：群聊历史中【名字】前缀表示不同群友说的话，你只用「小口口子」自己的身份回应，不要扮演其他人；私聊是一对一聊天。消息里如果附带了图片或表情包，就自然地对图片内容做出反应——吐槽、夸夸、接梗都可以，不要干巴巴地描述。如果消息里只有 [图片] 占位符而你看不到图片内容，就自然地说图没加载出来，不要假装看到了。你有一个联网搜索工具（web_search），只有在确实需要最新/实时信息（新闻、天气、价格、近期动态等）时才调用它，日常闲聊不要滥用。当前时间：${time}。）`

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
    const res = await call('get_friend_msg_history', { user_id: getProbeTarget('user'), count: 20 })
    let url = null
    for (const m of (res.messages || []).slice().reverse()) {
      if (Array.isArray(m.message)) {
        const img = m.message.find((s) => s.type === 'image' && s.data && s.data.url)
        if (img) { url = img.data.url; break }
      }
    }
    if (!url) { console.log('no image found'); process.exit(2) }
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
    const buf = Buffer.from(await r.arrayBuffer())
    console.log('download HTTP', r.status, r.headers.get('content-type'), buf.length, 'bytes')
    if (!r.ok) { console.log('download failed'); process.exit(3) }
    const mime = buf[0] === 0xff ? 'image/jpeg' : buf[0] === 0x89 ? 'image/png' : buf[0] === 0x47 ? 'image/gif' : 'image/jpeg'

    const res2 = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-vision-exp',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [{ type: 'text', text: '这是什么表情包' }, { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }] },
        ],
        temperature: 1.2,
        max_tokens: 2500,
        stream: false,
      }),
    })
    const t = await res2.text()
    console.log('HTTP', res2.status)
    const d = JSON.parse(t)
    console.log('content:', JSON.stringify(d.choices?.[0]?.message?.content)?.slice(0, 400))
    console.log('finish:', d.choices?.[0]?.finish_reason, 'usage:', JSON.stringify(d.usage))
    process.exit(0)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(5)
  }
}
setTimeout(() => process.exit(6), 120000)
