// 本地模拟：不连接 QQ、不下载图片、不调用模型。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { plusOneFingerprint, createAutoPlusOne } from '../src/autoPlusOne.js'
import { createBot } from '../src/bot.js'
import { OneBotClient } from '../src/onebot.js'

const selfId = '3399202820'
const logger = { info() {}, warn() {}, debug() {}, error() {} }
function removeTestDir(dir) {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(dir).startsWith('bot-plus-one-'))
  rmSync(dir, { recursive: true, force: true })
}
let passed = 0
async function test(name, task) { await task(); passed++; console.log(`PASS ${name}`) }
let nextId = 1
const text = value => [{ type: 'text', data: { text: value } }]
const event = (content = '复读测试', extra = {}) => ({ post_type: 'message', message_type: 'group', self_id: Number(selfId), group_id: 1124442491, user_id: 10001, message_id: nextId++, message: typeof content === 'string' ? text(content) : content, ...extra })
function setup(config = {}, send) {
  const sent = []
  const ob = { selfId, repeatGroupMessage: async (groupId, messageId) => { sent.push({ groupId, messageId }); if (send) await send() } }
  const cfg = { autoPlusOneEnabled: true, whitelistGroups: new Set([1124442491, 801944160]), ...config }
  const detector = createAutoPlusOne({ config: cfg, onebot: ob, logger })
  const handle = async evt => { const result = detector.observe(evt); await detector.send(result); return result }
  return { detector, handle, sent, config: cfg, ob }
}

await test('两条触发一次，第三/第四条及自己的跟读不会再次触发', async () => {
  const t = setup()
  await t.handle(event()); assert.equal(t.sent.length, 0)
  const second = event(); await t.handle(second); assert.deepEqual(t.sent, [{ groupId: second.group_id, messageId: second.message_id }])
  await t.handle(event('复读测试', { user_id: selfId, post_type: 'message_sent' }))
  await t.handle(event()); await t.handle(event()); assert.equal(t.sent.length, 1)
})
await test('不同消息打断后，同样内容重新连续两条可跟一次', async () => {
  const t = setup(); for (const s of ['A', 'A', 'A', 'B', 'A', 'A']) await t.handle(event(s))
  assert.equal(t.sent.length, 2)
})
await test('机器人自己不能起头，不能作为第二条，也不能凑两条', async () => {
  const t = setup()
  await t.handle(event('A', { user_id: Number(selfId) })); await t.handle(event('A')); assert.equal(t.sent.length, 0)
  await t.handle(event('A', { user_id: selfId })); await t.handle(event('A')); assert.equal(t.sent.length, 0)
  await t.handle(event('A')); assert.equal(t.sent.length, 1)
})
await test('自己的不同内容插话也会打断原来的计数', async () => {
  const t = setup(); await t.handle(event('A')); await t.handle(event('B', { user_id: selfId })); await t.handle(event('A'))
  assert.equal(t.sent.length, 0); await t.handle(event('A')); assert.equal(t.sent.length, 1)
})
await test('同一个群友连发两条也能跟读；不同群分开计数', async () => {
  const t = setup(); await t.handle(event('A')); await t.handle(event('A', { group_id: 801944160 }))
  assert.equal(t.sent.length, 0)
  await t.handle(event('A')); await t.handle(event('A', { group_id: 801944160 })); assert.equal(t.sent.length, 2)
})
await test('非白名单、私聊、功能关闭均不会发消息', async () => {
  const t = setup()
  for (const extra of [{ group_id: 999 }, { message_type: 'private' }]) { await t.handle(event('A', extra)); await t.handle(event('A', extra)) }
  t.config.autoPlusOneEnabled = false; await t.handle(event()); await t.handle(event()); assert.equal(t.sent.length, 0)
})
await test('开关和白名单修改即时生效，关闭期间的消息不计入', async () => {
  const t = setup(); await t.handle(event('A')); t.config.autoPlusOneEnabled = false; await t.handle(event('A'))
  t.config.autoPlusOneEnabled = true; await t.handle(event('A')); assert.equal(t.sent.length, 0)
  await t.handle(event('A')); assert.equal(t.sent.length, 1)
  t.config.whitelistGroups.delete(1124442491); await t.handle(event('B')); await t.handle(event('B')); assert.equal(t.sent.length, 1)
})
await test('重复消息事件和重连重放不会凑两条，不让旧消息打断当前段', async () => {
  const t = setup(); const a = event('A'); await t.handle(a); assert.equal((await t.handle(a)).duplicate, true)
  const b = event('B'); await t.handle(b); await t.handle(a); assert.equal(t.sent.length, 0)
  await t.handle(event('B')); assert.equal(t.sent.length, 1)
})
await test('真实群序号跳跃时不把漏收的两条当成连续；迟到事件忽略', async () => {
  const t = setup(); await t.handle(event('A', { real_seq: '10' })); await t.handle(event('A', { real_seq: '12' })); assert.equal(t.sent.length, 0)
  assert.equal((await t.handle(event('B', { real_seq: '11' }))).duplicate, true)
  await t.handle(event('A', { real_seq: '13' })); assert.equal(t.sent.length, 1)
})
await test('发送期间更多相同消息进入，只有一次发送', async () => {
  let release; const t = setup({}, () => new Promise(resolve => { release = resolve }))
  await t.handle(event()); const second = t.handle(event()); const rest = Array.from({ length: 8 }, () => t.handle(event()))
  assert.equal(t.sent.length, 1); release(); await Promise.all([second, ...rest]); assert.equal(t.sent.length, 1)
})
await test('同一发送机会不能被调用两次；超时也不会在后续消息重复发送', async () => {
  const t = setup({}, async () => { throw Error('timeout') }); t.detector.observe(event())
  const result = t.detector.observe(event()); await Promise.all([t.detector.send(result), t.detector.send(result)])
  await t.handle(event()); assert.equal(t.sent.length, 1)
})
await test('预留后连续段或开关已改变，放弃过时发送', async () => {
  const t = setup(); t.detector.observe(event('A')); const result = t.detector.observe(event('A'))
  t.detector.observe(event('B')); await t.detector.send(result); assert.equal(t.sent.length, 0)
  const b = t.detector.observe(event('B')); t.config.autoPlusOneEnabled = false; await t.detector.send(b); assert.equal(t.sent.length, 0)
})
await test('文字保持空格、换行；相邻文本分段与 CQ 格式可匹配', async () => {
  assert.notEqual(plusOneFingerprint(text('A B')), plusOneFingerprint(text('A  B')))
  assert.notEqual(plusOneFingerprint(text('A\nB')), plusOneFingerprint(text('A B')))
  assert.equal(plusOneFingerprint(text('A\nB')), plusOneFingerprint([{ type: 'text', data: { text: 'A\n' } }, { type: 'text', data: { text: 'B' } }]))
  assert.equal(plusOneFingerprint(text('A[B]&')), plusOneFingerprint('A&#91;B&#93;&amp;'))
  assert.equal(plusOneFingerprint(text('&#91;')), plusOneFingerprint('&amp;#91;'))
})
await test('相同图片、不同图片与失效链接图片都不触发 +1', async () => {
  const md5 = 'a'.repeat(32), other = 'b'.repeat(32)
  const img = (file, url) => [{ type: 'image', data: { file: `${file}.jpg`, url } }]
  const a = img(md5, 'https://multimedia.nt.qq.com.cn/download?fileid=one&rkey=old')
  const b = img(md5.toUpperCase(), 'https://multimedia.nt.qq.com.cn/download?fileid=one&rkey=new')
  for (const raw of [a, b, img(other, b[0].data.url)]) assert.equal(plusOneFingerprint(raw), null)
  const t = setup(); await t.handle(event(a)); await t.handle(event(b)); assert.equal(t.sent.length, 0)
  assert.equal(plusOneFingerprint([{ type: 'image', data: {} }]), null)
})
await test('QQ 图片、QQ 表情与对应 CQ 码均不跟读', async () => {
  const image = key => [{ type: 'image', data: { url: `https://multimedia.nt.qq.com.cn/download?fileid=abc&rkey=${key}` } }]
  assert.equal(plusOneFingerprint(image('old')), null); assert.equal(plusOneFingerprint(image('new')), null)
  const face = resultId => [{ type: 'face', data: { id: '178', resultId } }]
  for (const raw of [face(''), face('1'), face('2'), '[CQ:face,id=178]', '[CQ:image,file=test.jpg]']) assert.equal(plusOneFingerprint(raw), null)
})
await test('文字混合图片或 QQ 表情也不触发 +1', async () => {
  const a = [...text('A'), { type: 'image', data: { file: `${'a'.repeat(32)}.png` } }, { type: 'face', data: { id: '14' } }]
  for (const raw of [a, a.slice(0, 2), [a[0], a[2]], `A[CQ:image,file=${'a'.repeat(32)}.png][CQ:face,id=14]`]) {
    assert.equal(plusOneFingerprint(raw), null)
    const t = setup(); const extra = typeof raw === 'string' ? { message: raw } : {}
    await t.handle(event(raw, extra)); await t.handle(event(raw, extra)); assert.equal(t.sent.length, 0)
  }
})
await test('指令、@、引用与不支持的消息不会跟读，并打断连续段', async () => {
  for (const raw of ['/今日猪猪', '／群总结 3', '群总结', '/id_check', ' ', ...['image', 'face', 'at', 'reply', 'file', 'video', 'record', 'json', 'dice', 'forward'].map(type => [{ type, data: { qq: selfId, id: 1 } }])]) {
    assert.equal(plusOneFingerprint(typeof raw === 'string' ? text(raw) : raw), null)
    const t = setup(); await t.handle(event('A')); await t.handle(event(raw)); await t.handle(event('A')); assert.equal(t.sent.length, 0)
  }
})
await test('不知道自身账号或缺少可去重消息编号时，不触发', async () => {
  const t = setup(); t.ob.selfId = ''
  await t.handle(event('A', { self_id: null })); await t.handle(event('A', { self_id: null })); assert.equal(t.sent.length, 0)
  t.ob.selfId = selfId; await t.handle(event('A', { message_id: null })); await t.handle(event('A')); assert.equal(t.sent.length, 0)
})
await test('重启不再跟已触发的同内容段；不同内容后恢复；保存文件没有原文', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bot-plus-one-'))
  try {
    const a = setup({ dataDir: dir }); await a.handle(event('敏感原文不会保存')); await a.handle(event('敏感原文不会保存')); a.detector.flush()
    const stored = readFileSync(path.join(dir, 'auto-plus-one.json'), 'utf8'); assert.ok(!stored.includes('敏感原文'))
    const b = setup({ dataDir: dir }); await b.handle(event('敏感原文不会保存')); await b.handle(event('敏感原文不会保存')); assert.equal(b.sent.length, 0)
    await b.handle(event('B')); await b.handle(event('敏感原文不会保存')); await b.handle(event('敏感原文不会保存')); assert.equal(b.sent.length, 1); b.detector.flush()
  } finally { removeTestDir(dir) }
})
await test('停机前一条与重启后一条不凑两条；重启后新收到两条才跟读', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bot-plus-one-'))
  try {
    const a = setup({ dataDir: dir }); await a.handle(event('A')); a.detector.flush()
    const b = setup({ dataDir: dir }); await b.handle(event('A')); assert.equal(b.sent.length, 0)
    await b.handle(event('A')); assert.equal(b.sent.length, 1); b.detector.flush()
  } finally { removeTestDir(dir) }
})

function mockBot(config = {}, llmChat = async () => { throw Error('不应调用模型') }) {
  const sent = [], normal = [], captured = [], store = new Map()
  let modelCalls = 0
  const cfg = { autoPlusOneEnabled: true, whitelistGroups: new Set([1124442491]), mutedGroups: new Set(), quietHours: '', proactiveRate: 0,
    proactiveCooldownMs: 0, contextRememberAll: true, replyMaxLines: 1, replyLineMaxChars: 40, humanDelayMinMs: 0, humanDelayMaxMs: 0,
    emojiKeepRate: 0, ...config }
  const memory = { get: key => store.get(key) || [], push(key, role, content) { const list = store.get(key) || []; list.push({ role, content }); store.set(key, list) } }
  const bot = createBot({ config: cfg, logger, onebot: { selfId, repeatGroupMessage: async (g, id) => sent.push({ g, id }), sendGroup: async (g, text) => normal.push({ g, text }) },
    llm: { chat: async (...args) => { modelCalls++; return llmChat(...args) } }, memory, buildSystemPrompt: () => '测试',
    dailySummary: { capture: evt => captured.push(evt.message_id), summaryGroups: () => [1124442491] },
    chatSettings: { get: () => ({ enabled: false, proactiveEnabled: false }), resolve: () => ({ enabled: false }) } })
  return { bot, sent, normal, captured, memory, get modelCalls() { return modelCalls } }
}
await test('机器人完整流程：普通聊天关闭仍跟读，消息仍捕获，不调用 LLM', async () => {
  const t = mockBot(); for (let i = 0; i < 4; i++) await t.bot.handleMessage(event())
  assert.equal(t.sent.length, 1); assert.equal(t.modelCalls, 0); assert.equal(t.normal.length, 0); assert.equal(t.captured.length, 4)
})
await test('机器人完整流程：静音、安静时段和主动搭话禁用不阻挡 +1', async () => {
  const t = mockBot({ mutedGroups: new Set([1124442491]), quietHours: '00:00-23:59', proactiveRate: 0 })
  await t.bot.handleMessage(event()); await t.bot.handleMessage(event()); assert.equal(t.sent.length, 1); assert.equal(t.modelCalls, 0)
})
await test('机器人完整流程：图片连发不会被自动 +1', async () => {
  const t = mockBot(); const raw = [{ type: 'image', data: { file: `${'a'.repeat(32)}.jpg`, url: 'https://example.invalid/image' } }]
  const original = globalThis.fetch; globalThis.fetch = () => { throw Error('不应下载') }
  try { await t.bot.handleMessage(event(raw)); await t.bot.handleMessage(event(raw)); assert.equal(t.sent.length, 0); assert.equal(t.modelCalls, 0) } finally { globalThis.fetch = original }
})
await test('机器人完整流程：自己的 message_sent 和自发普通事件不触发模型或跟读', async () => {
  const t = mockBot(); await t.bot.handleMessage(event('A', { post_type: 'message_sent', user_id: selfId })); await t.bot.handleMessage(event('A'))
  assert.equal(t.sent.length, 0); assert.equal(t.modelCalls, 0); await t.bot.handleMessage(event('A')); assert.equal(t.sent.length, 1)
})
await test('第一条慢速普通回复在第二条触发后取消，避免插话破坏复读段', async () => {
  let complete; const cfg = { autoPlusOneEnabled: true, whitelistGroups: new Set([1124442491]), mutedGroups: new Set(), quietHours: '', proactiveRate: 1, proactiveCooldownMs: 0, contextRememberAll: true, replyMaxLines: 1, replyLineMaxChars: 40, humanDelayMinMs: 0, humanDelayMaxMs: 0, emojiKeepRate: 0 }
  const sent = [], store = []
  const bot = createBot({ config: cfg, logger, onebot: { selfId, repeatGroupMessage: async () => sent.push('plus-one'), sendGroup: async () => sent.push('chat') },
    llm: { chat: () => new Promise(resolve => { complete = resolve }) }, memory: { get: () => store, push: (_, role, content) => store.push({ role, content }) }, buildSystemPrompt: () => '测试' })
  const first = bot.handleMessage(event('A')); assert.ok(complete)
  await bot.handleMessage(event('A')); complete('这是慢速普通回复'); await first; assert.deepEqual(sent, ['plus-one'])
})
await test('OneBot 原生单条转发参数正确，保持消息编号原样', async () => {
  const ob = new OneBotClient({ url: 'ws://test', logger }); let request
  ob.api = async (action, params) => { request = { action, params }; return null }
  await ob.repeatGroupMessage(1124442491, '-123456789')
  assert.deepEqual(request, { action: 'forward_group_single_msg', params: { group_id: '1124442491', message_id: '-123456789' } })
})
await test('OneBot 接收 message_sent，交给机器人处理自身插话', async () => {
  const original = globalThis.WebSocket; let socket
  class FakeSocket extends EventTarget {
    static OPEN = 1
    constructor() { super(); socket = this; this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    send(raw) { const p = JSON.parse(raw); queueMicrotask(() => this.message({ echo: p.echo, status: 'ok', data: p.action === 'get_login_info' ? { user_id: Number(selfId), nickname: '测试' } : { online: false, good: true } })) }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
    close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })) }
  }
  globalThis.WebSocket = FakeSocket; const ob = new OneBotClient({ url: 'ws://test', logger })
  try {
    const received = []; ob.on('message', evt => received.push(evt)); const ready = new Promise(resolve => ob.once('ready', resolve)); const running = ob.run(); await ready
    const outgoing = event('A', { post_type: 'message_sent', user_id: selfId }); socket.message(outgoing)
    assert.equal(received.length, 1); assert.deepEqual(received[0], outgoing); ob.stop(); await running
  } finally { ob.stop(); globalThis.WebSocket = original }
})
console.log(`${passed} cases passed`)
