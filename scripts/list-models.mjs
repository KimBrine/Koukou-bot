import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const DS_KEY = repoLocalConfig.deepseekApiKey
const QW_KEY = repoLocalConfig.dashscopeApiKey

console.log('=== DeepSeek 可用模型 ===')
try {
  const r = await fetch('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${DS_KEY}` },
  })
  const data = await r.json()
  for (const m of data.data || []) console.log(' -', m.id)
} catch (e) {
  console.log('查询失败:', e.message)
}

console.log('=== DashScope 可用模型（vl/flash 相关）===')
try {
  const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/models', {
    headers: { Authorization: `Bearer ${QW_KEY}` },
  })
  const data = await r.json()
  const all = (data.data || []).map((m) => m.id)
  console.log('全部模型数:', all.length)
  const interesting = all.filter((id) => /flash|vl|vision|3\.7|3-7/i.test(id))
  for (const id of interesting) console.log(' -', id)
  console.log('--- 其余模型名示例（前 30 个）---')
  for (const id of all.slice(0, 30)) console.log(' *', id)
} catch (e) {
  console.log('查询失败:', e.message)
}
