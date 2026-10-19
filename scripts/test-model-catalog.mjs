import assert from 'node:assert/strict'
import { PROVIDERS, REASONING_LEVELS, normalizeProvider, normalizeReasoning, reasoningPayload, detectModels } from '../src/modelCatalog.js'

// 供应商目录
assert.ok(PROVIDERS.length >= 5)
assert.ok(PROVIDERS.every(p => p.id && p.name))
assert.equal(normalizeProvider('DeepSeek').id, 'deepseek')
assert.equal(normalizeProvider('不存在的').id, 'custom', '未知供应商退回自定义')

// 思考强度
assert.deepEqual(REASONING_LEVELS.map(l => l.id), ['', 'low', 'medium', 'high'])
assert.equal(normalizeReasoning('HIGH'), 'high')
assert.equal(normalizeReasoning('关闭'), '', '不认识的取值一律当作关闭')
assert.deepEqual(reasoningPayload(''), {})
assert.deepEqual(reasoningPayload('medium'), { reasoning_effort: 'medium' })

// 自动检测：OpenAI 风格
const fake = (status, payload) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
})
let out = await detectModels({ baseUrl: 'https://api.deepseek.com/', apiKey: 'k', fetchImpl: fake(200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }) })
assert.equal(out.count, 2)
assert.equal(out.url, 'https://api.deepseek.com/models', '末尾斜杠要被去掉')
assert.deepEqual(out.models.map(m => m.id), ['deepseek-chat', 'deepseek-reasoner'])

// 自动检测：{models:[]} 风格
out = await detectModels({ baseUrl: 'http://127.0.0.1:11434/v1', fetchImpl: fake(200, { models: [{ name: 'qwen2.5' }] }) })
assert.equal(out.models[0].id, 'qwen2.5')

// 错误分支
await assert.rejects(() => detectModels({ baseUrl: '', fetchImpl: fake(200, {}) }), /接口地址/)
await assert.rejects(() => detectModels({ baseUrl: 'ftp://x', fetchImpl: fake(200, {}) }), /http/)
await assert.rejects(() => detectModels({ baseUrl: 'https://x.com', apiKey: 'k', fetchImpl: fake(401, {}) }), /401|密钥/)
await assert.rejects(() => detectModels({ baseUrl: 'https://x.com', fetchImpl: fake(200, { data: [] }) }), /没有返回任何模型/)
await assert.rejects(
  () => detectModels({ baseUrl: 'https://x.com', fetchImpl: async () => { throw new Error('ECONNREFUSED') } }),
  /连不上|ECONNREFUSED/,
)
// 超时
await assert.rejects(
  () => detectModels({ baseUrl: 'https://x.com', fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e } }),
  /超时/,
)

console.log('模型目录与自动检测检查通过：3 组目录断言 + 9 组检测用例。')
