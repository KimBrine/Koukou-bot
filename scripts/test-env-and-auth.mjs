import { loadConfig as loadRepoLocalConfig } from '../src/config.js'
const repoLocalConfig = loadRepoLocalConfig()

import { writeFileSync } from 'node:fs'

const out = []
out.push(`pid: ${process.pid}`)
out.push(`cwd: ${process.cwd()}`)
out.push(`node: ${process.version}`)
for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'USERNAME', 'USERPROFILE', 'COMPUTERNAME']) {
  out.push(`env ${v} = ${process.env[v] || '-'}`)
}

const KEY = repoLocalConfig.dashscopeApiKey
try {
  const r = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'qwen3.7-flash', messages: [{ role: 'user', content: '回复收到' }], max_tokens: 10 }),
  })
  const t = await r.text()
  out.push(`dashscope text: HTTP ${r.status} | ${t.slice(0, 200)}`)

  // 再测一次带图（1x1 会 400 但能确认鉴权是否通过——400 尺寸错误说明鉴权 OK）
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const r2 = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'qwen3.7-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: '什么颜色' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } }] }],
      max_tokens: 10,
    }),
  })
  const t2 = await r2.text()
  out.push(`dashscope vision: HTTP ${r2.status} | ${t2.slice(0, 200)}`)
} catch (e) {
  out.push(`fetch ERR: ${e.message}`)
}
writeFileSync('logs/env-test.log', out.join('\n'))
