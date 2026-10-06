import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

const KEY = repoLocalConfig.deepseekApiKey
for (const maxTokens of [150, 250]) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: '你是群友「小口口子」，回复永远不超过 25 个字，一句话，口语化。' },
        { role: 'user', content: '【落叶】在群里发了张表情包，还说：这是什么' },
      ],
      temperature: 1.2,
      max_tokens: maxTokens,
      stream: false,
    }),
  })
  const d = await r.json()
  const m = d.choices?.[0]?.message || {}
  console.log(`max_tokens=${maxTokens} HTTP ${r.status} finish=${d.choices?.[0]?.finish_reason}`)
  console.log(`  content(${m.content?.length ?? 0}字): ${JSON.stringify(m.content)}`)
  console.log(`  推理token数: ${d.usage?.completion_tokens_details?.reasoning_tokens ?? 0}, 总completion: ${d.usage?.completion_tokens}`)
}
