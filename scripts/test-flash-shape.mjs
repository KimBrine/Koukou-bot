import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const KEY = repoLocalConfig.deepseekApiKey
const r = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: '你是一个总结助手。用两三句话总结用户给的聊天记录。' },
      { role: 'user', content: '[12:00] 小明：今天好热啊\n[12:01] 小红：确实，快40度了\n[12:02] 小明：去游泳吗\n[12:03] 小红：走起！' },
    ],
    max_tokens: 300,
  }),
})
const t = await r.text()
console.log('HTTP', r.status)
const d = JSON.parse(t)
console.log('finish_reason:', d.choices?.[0]?.finish_reason)
console.log('message keys:', Object.keys(d.choices?.[0]?.message || {}))
console.log('content:', JSON.stringify(d.choices?.[0]?.message?.content)?.slice(0, 400))
console.log('reasoning_content length:', d.choices?.[0]?.message?.reasoning_content?.length ?? 0)
console.log('usage:', JSON.stringify(d.usage))
