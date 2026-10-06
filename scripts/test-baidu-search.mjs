import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const KEY = repoLocalConfig.baiduApiKey

const endpoints = [
  { url: 'https://qianfan.baidubce.com/v2/ai_search/web_search', body: { messages: [{ role: 'user', content: '今天北京天气怎么样' }], search_strategy: 'speed', stream: false } },
]

for (const ep of endpoints) {
  try {
    const r = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(ep.body),
    })
    const t = await r.text()
    console.log('HTTP', r.status, '|', t.slice(0, 600))
  } catch (e) {
    console.log('ERR:', e.message)
  }
}
