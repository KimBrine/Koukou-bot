import { readFileSync } from 'node:fs'

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const m = envText.match(/^DEEPSEEK_API_KEY=(.+)$/m)
const key = (m?.[1] ?? '').trim()
console.log('key length:', key.length, 'head:', key.slice(0, 8), 'tail:', key.slice(-4))

const res = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '只回复两个字：收到' }],
    max_tokens: 10,
  }),
})
const text = await res.text()
console.log('HTTP', res.status)
console.log(text.slice(0, 400))
process.exit(res.ok ? 0 : 1)
