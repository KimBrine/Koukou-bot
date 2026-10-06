import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const KEY = repoLocalConfig.deepseekApiKey
const r = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '帮我查一下今天北京的天气，需要最新数据' }],
    tools: [{
      type: 'function',
      function: {
        name: 'web_search',
        description: '当需要最新信息时使用',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    }],
    max_tokens: 300,
  }),
})
const t = await r.text()
console.log('HTTP', r.status)
const d = JSON.parse(t)
const m = d.choices?.[0]?.message || {}
console.log('finish_reason:', d.choices?.[0]?.finish_reason)
console.log('content:', JSON.stringify(m.content)?.slice(0, 120))
console.log('tool_calls:', JSON.stringify(m.tool_calls)?.slice(0, 300))
