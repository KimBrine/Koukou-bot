import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const DS_KEY = repoLocalConfig.deepseekApiKey
const QW_KEY = repoLocalConfig.dashscopeApiKey
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

console.log('=== DeepSeek deepseek-v4-pro 文本测试 ===')
{
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS_KEY}` },
    body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 10 }),
  })
  const t = await r.text()
  console.log('HTTP', r.status, '|', t.slice(0, 150))
}

console.log('=== qwen3.7-flash 视觉输入测试 ===')
{
  const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${QW_KEY}` },
    body: JSON.stringify({
      model: 'qwen3.7-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: '这张图是什么颜色？' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } }] }],
      max_tokens: 20,
    }),
  })
  const t = await r.text()
  console.log('HTTP', r.status, '|', t.slice(0, 250))
}

console.log('=== 备用：qwen3-vl-flash 视觉输入测试 ===')
{
  const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${QW_KEY}` },
    body: JSON.stringify({
      model: 'qwen3-vl-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: '这张图是什么颜色？' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } }] }],
      max_tokens: 20,
    }),
  })
  const t = await r.text()
  console.log('HTTP', r.status, '|', t.slice(0, 250))
}
