const KEY = process.env.DS_KEY
const models = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']

for (const model of models) {
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是群友「小口口子」，回复永远不超过 20 个字，一句话，口语化。' },
          { role: 'user', content: '【落叶】在群里发了张表情包，还说：这是什么' },
        ],
        temperature: 1.2,
        max_tokens: 250,
        stream: false,
      }),
    })
    const t = await r.text()
    if (!r.ok) {
      console.log(`model=${model} → HTTP ${r.status}: ${t.slice(0, 180)}`)
      continue
    }
    const d = JSON.parse(t)
    const m = d.choices?.[0]?.message || {}
    console.log(`model=${model} → HTTP 200`)
    console.log(`  实际版本: ${d.model}`)
    console.log(`  content(${m.content?.length ?? 0}字): ${JSON.stringify(m.content)}`)
    console.log(`  推理token: ${d.usage?.completion_tokens_details?.reasoning_tokens ?? 0} / 总 completion: ${d.usage?.completion_tokens}`)
  } catch (e) {
    console.log(`model=${model} → ERR ${e.message}`)
  }
}
