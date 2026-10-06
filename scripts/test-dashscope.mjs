import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const KEY = repoLocalConfig.dashscopeApiKey
const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

for (const model of ['qwen-vl-plus', 'qwen3-vl-plus']) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
        max_tokens: 10,
      }),
    })
    const text = await res.text()
    console.log(`model=${model} HTTP ${res.status}: ${text.slice(0, 200)}`)
    if (res.ok) break
  } catch (e) {
    console.log(`model=${model} ERR: ${e.message}`)
  }
}
