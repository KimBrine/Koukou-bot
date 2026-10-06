const KEY = process.env.DS_KEY

console.log('=== 1. 官方模型列表（GET /models，用你的 Key）===')
try {
  const r = await fetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${KEY}` } })
  console.log('HTTP', r.status)
  console.log(await r.text())
} catch (e) {
  console.log('ERR', e.message)
}

console.log('\n=== 2. 逐个测试候选模型名（POST /chat/completions）===')
const candidates = [
  'deepseek-v4.1-flash-max',
  'deepseek-v41-flash-max',
  'deepseek-v4-flash-max',
  'deepseek-flash-max',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-pro',
  'deepseek-flash',
  'deepseek-v4-pro',
]
for (const model of candidates) {
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
    })
    const t = await r.text()
    if (r.ok) {
      const d = JSON.parse(t)
      console.log(`✅ ${model.padEnd(26)} HTTP 200 → 实际路由: ${d.model}`)
    } else {
      let msg = t.slice(0, 120)
      try {
        msg = JSON.parse(t).error?.message ?? msg
      } catch {}
      console.log(`❌ ${model.padEnd(26)} HTTP ${r.status} → ${msg}`)
    }
  } catch (e) {
    console.log(`❌ ${model.padEnd(26)} ERR ${e.message}`)
  }
}
