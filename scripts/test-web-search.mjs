import assert from 'node:assert/strict'
import { createWebSearch, parseBingResults } from '../src/search.js'

const b64 = Buffer.from('https://example.com/a?b=1').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const html = '<html><body><ol id="b_results">'
  + '<li class="b_algo" data-id="1"><h2><a href="https://www.example.com/x" h="ID=SERP,1">第一条 <strong>标题</strong></a></h2><div class="b_caption"><p class="b_lineclamp2">第一段摘要 &amp; 说明</p></div></li>'
  + '<li class="b_algo" data-id="2"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1' + b64 + '&amp;ntb=1">第二条</a></h2><p>第二段摘要</p></li>'
  + '</ol></body></html>'

const refs = parseBingResults(html)
assert.equal(refs.length, 2)
assert.equal(refs[0].title, '第一条 标题')
assert.equal(refs[0].snippet, '第一段摘要 & 说明')
assert.equal(refs[1].url, 'https://example.com/a?b=1', '必应跳转链接要还原')
assert.equal(parseBingResults('<html></html>').length, 0)

let bingCalls = 0
const fakeBing = async () => { bingCalls++; return { ok: true, status: 200, text: async () => html } }
const bing = createWebSearch({ provider: 'bing', fetchImpl: fakeBing, timeoutMs: 1000 })
const r1 = await bing('测试')
assert.equal(r1.refs.length, 2)
await bing('测试')
assert.equal(bingCalls, 1, '同一查询走缓存')

let dashCalls = 0
const fakeDash = async (url, init) => {
  dashCalls++
  const body = JSON.parse(init.body)
  assert.equal(body.parameters.enable_search, true, '必须带联网搜索参数')
  return { ok: true, status: 200, json: async () => ({ output: { choices: [{ message: { content: '通义联网答案' } }] } }) }
}
const dash = createWebSearch({ dashscopeApiKey: 'd', provider: 'dashscope', fetchImpl: fakeDash })
const rd = await dash('今天新闻')
assert.equal(rd.summary, '通义联网答案')
assert.equal(dash.providerName, 'dashscope')

const autoDash = createWebSearch({ dashscopeApiKey: 'd', provider: 'auto', fetchImpl: fakeDash })
assert.equal(autoDash.providerName, 'dashscope', 'auto 有通义 Key 就走通义 API')
await autoDash('另一个问题')
assert.equal(dashCalls, 2)

const fakeBaidu = async () => ({
  ok: true, status: 200,
  json: async () => ({ content: '百度总结', references: [{ title: 'T', url: 'https://a.example', content: 'C' }] }),
})
const baidu = createWebSearch({ apiKey: 'k', dashscopeApiKey: 'd', provider: 'auto', fetchImpl: fakeBaidu })
assert.equal(baidu.providerName, 'baidu', '有千帆 Key 时优先千帆')
assert.equal((await baidu('q')).summary, '百度总结')

assert.equal(createWebSearch({ provider: 'off' }), null, 'off 必须返回 null')

console.log('联网搜索检查通过：通义 API / 千帆兼容 / 必应兜底 / 缓存 / 关闭开关')
