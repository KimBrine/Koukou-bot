// 离线模拟登录补发、迟到生成与上下文恢复，不调用 QQ 或模型 API。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MessageTimeline } from '../src/messageFreshness.js'
import { MemoryStore, modelHistory } from '../src/memory.js'
import { createBot } from '../src/bot.js'
import { createTargetWatch } from '../src/targetWatch.js'
import { OneBotClient } from '../src/onebot.js'

const logger = { info() {}, warn() {}, debug() {}, error() {} }
const group = 200000002, selfId = '200000010', user = 200000011
const dir = mkdtempSync(path.join(os.tmpdir(), 'koukou-freshness-'))
const stores = []
let fileId = 0, messageId = 0, passed = 0
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }
function store(limit = 99) {
  const memory = new MemoryStore({ file: path.join(dir, `${++fileId}.json`), limit, logger })
  stores.push(memory)
  return memory
}
function setup({ chat, config = {} } = {}) {
  let time = Math.floor(Date.now() / 1000) * 1000
  const timeline = new MessageTimeline({ now: () => time }); timeline.begin()
  const memory = store(), sent = [], requests = [], captures = [], watches = [], chains = [], triggers = []
  const onebot = { selfId, messageTimeline: timeline, sendGroup: async (_, msg) => sent.push(msg),
    sendPrivate: async (_, msg) => sent.push(msg), repeatGroupMessage: async () => sent.push('plus-one') }
  const cfg = { whitelistGroups: new Set([group]), mutedGroups: new Set(), proactiveRate: 1, proactiveCooldownMs: 0,
    quietHours: '', contextRememberAll: true, autoPlusOneEnabled: true, replyMaxLines: 1, replyLineMaxChars: 40,
    humanDelayMinMs: 0, humanDelayMaxMs: 0, emojiKeepRate: 0, replyLengthMatch: false, ...config }
  const bot = createBot({ config: cfg, logger, onebot, memory, rand: () => 0.5, buildSystemPrompt: () => '聊天',
    llm: { chat: async (...args) => { requests.push(args); return chat ? chat(...args) : '现在去报名呀' } },
    dailySummary: { capture: evt => captures.push(evt.message_id), summaryGroups: () => [group], trigger: () => triggers.push('summary') },
    dailyPing: { noteMessage: async evt => chains.push(evt.message_id) }, targetWatch: { note: evt => watches.push(evt.message_id), markReplied() {} } })
  function event(content, extra = {}) {
    const evt = { post_type: 'message', message_type: 'group', self_id: Number(selfId), user_id: user,
      group_id: group, time: time / 1000, message_id: ++messageId, sender: { nickname: '群友甲' },
      message: [{ type: 'text', data: { text: content } }], ...extra }
    evt.messageContext = timeline.receive(evt)
    return evt
  }
  return { bot, memory, timeline, onebot, cfg, sent, requests, captures, watches, chains, triggers, event,
    advance: ms => { time += ms }, time: () => time }
}

try {
  await test('登录前的消息即使只早一秒，也只补上下文与总结，不搭话或 +1', async () => {
    const t = setup()
    for (let i = 0; i < 150; i++) await t.bot.handleMessage(t.event('昨天吃什么', { time: (t.time() - 60_000) / 1000 }))
    assert.equal(t.sent.length, 0); assert.equal(t.requests.length, 0)
    assert.equal(t.captures.length, 150); assert.equal(t.watches.length, 0); assert.equal(t.chains.length, 0)
    assert.ok(t.memory.get(`g${group}`).every(m => m.historical && m.time === t.time() - 60_000))
    assert.equal(t.timeline.receive({ time: t.time() / 1000 - 1 }).historical, true)
  })
  await test('旧 @、私聊及群总结指令均不补答、不重新执行', async () => {
    const t = setup()
    for (const message_type of ['group', 'private']) {
      const evt = t.event('/群总结', { message_type, time: t.time() / 1000 - 3600,
        message: [{ type: 'at', data: { qq: selfId } }, { type: 'text', data: { text: '/群总结' } }] })
      await t.bot.handleMessage(evt)
    }
    assert.equal(t.requests.length, 0); assert.equal(t.triggers.length, 0); assert.equal(t.sent.length, 0)
    assert.match(t.memory.get(`p${user}`)[0].content, /群总结/)
  })
  await test('contextRememberAll 关闭时仍阅读离线补发消息；缺时间或异常时间不当作当前消息', async () => {
    const t = setup({ config: { contextRememberAll: false } })
    for (const time of [undefined, 0, 1e20, t.time() / 1000 + 100]) await t.bot.handleMessage(t.event('背景信息', { time }))
    assert.equal(t.sent.length, 0); assert.equal(t.requests.length, 0)
    assert.equal(t.memory.get(`g${group}`).length, 4)
  })
  await test('旧消息阅读后，当前消息自然回复；模型看到时间和背景标记，元数据不传入 API', async () => {
    const t = setup({ config: { autoPlusOneEnabled: false } })
    await t.bot.handleMessage(t.event('上周玩什么游戏', { time: t.time() / 1000 - 86400 }))
    await t.bot.handleMessage(t.event('今天活动怎么报名'))
    assert.equal(t.sent.length, 1); assert.equal(t.requests.length, 1)
    const [prompt, messages] = t.requests[0]
    assert.match(prompt, /优先衔接当前话题/)
    assert.match(messages[0].content, /登录补读；历史消息/)
    assert.match(messages.at(-1).content, /^【群友甲】今天活动怎么报名\n/);
    const target=JSON.parse(messages.at(-1).content.match(/本轮定位数据 ([\s\S]*)】$/)[1]);assert.equal(target.text,'今天活动怎么报名');assert.equal(target.precedingDialogueWithThisSender.length,0)
    assert.ok(messages.every(m => Object.keys(m).sort().join(',') === 'content,role'))
  })
  await test('旧消息迟到不排在新话题之后；按发送时间存储并保留到重启后', async () => {
    const memory = store(4)
    memory.push('g1', 'user', '今天活动', { time: 2000, messageId: '2' })
    memory.push('g1', 'user', '昨天游戏', { time: 1000, historical: true, messageId: '1' })
    memory.push('g1', 'user', '昨天游戏重复事件', { time: 1000, historical: true, messageId: '1' })
    memory.flush()
    const restored = new MemoryStore({ file: memory.file, limit: 4, logger }); restored.load()
    assert.deepEqual(restored.get('g1').map(m => m.content), ['昨天游戏', '今天活动'])
    assert.equal(restored.get('g1')[0].historical, true)
    const persisted = JSON.parse(readFileSync(memory.file, 'utf8'))
    assert.equal(persisted.g1[1].time, 2000)
  })
  await test('新话题已占满窗口时，旧消息进入长期记忆，不挤走当前话题', async () => {
    const memory = store(2), evicted = []
    memory.onEvict = (_, items) => evicted.push(...items)
    memory.push('g1', 'user', '当前甲', { time: 2000 })
    memory.push('g1', 'user', '当前乙', { time: 3000 })
    memory.push('g1', 'user', '历史', { time: 1000, historical: true })
    assert.deepEqual(memory.get('g1').map(m => m.content), ['当前甲', '当前乙'])
    assert.deepEqual(evicted, [{ role: 'user', content: '历史', time: 1000, historical: true }])
  })
  await test('旧格式记忆仍可载入，未知时间标为背景', () => {
    const memory = store(); writeFileSync(memory.file, JSON.stringify({ g1: [{ role: 'user', content: '旧记忆' }] }))
    memory.load(); assert.match(modelHistory(memory.get('g1'))[0].content, /时间未知/)
  })
  await test('同一秒内新消息不插到上一条回答前面；实时乱序不把旧话题重新设为当前', () => {
    const memory = store()
    memory.push('g1', 'user', '第一句', { time: 1000 })
    memory.push('g1', 'assistant', '回答', { time: 1800 })
    memory.push('g1', 'user', '新一句', { time: 1000 })
    assert.deepEqual(memory.get('g1').map(m => m.content), ['第一句', '回答', '新一句'])
    let now = 100_000
    const timeline = new MessageTimeline({ now: () => now }); timeline.begin(); now += 10_000
    const latest = timeline.receive({ message_type: 'group', group_id: group, time: 110, user_id: user })
    const delayed = timeline.receive({ message_type: 'group', group_id: group, time: 109, user_id: user })
    assert.equal(timeline.isCurrent(latest, { latestOnly: true }), true)
    assert.equal(timeline.isCurrent(delayed, { latestOnly: true }), false)
  })
  await test('补发的旧消息不会与第一条新消息凑成自动 +1，实时两条仍只跟一次', async () => {
    const t = setup({ config: { proactiveRate: 0 } })
    await t.bot.handleMessage(t.event('复读', { time: t.time() / 1000 - 100 }))
    await t.bot.handleMessage(t.event('复读')); assert.deepEqual(t.sent, [])
    await t.bot.handleMessage(t.event('复读')); await t.bot.handleMessage(t.event('复读'))
    assert.deepEqual(t.sent, ['plus-one'])
  })
  await test('断线前一条与新会话第一条不凑 +1', async () => {
    const t = setup({ config: { proactiveRate: 0 } })
    await t.bot.handleMessage(t.event('复读'))
    t.timeline.end(); t.advance(1000); t.timeline.begin()
    await t.bot.handleMessage(t.event('复读')); assert.deepEqual(t.sent, [])
    await t.bot.handleMessage(t.event('复读')); assert.deepEqual(t.sent, ['plus-one'])
  })
  await test('断线前尚在生成的回复恢复登录后不发送', async () => {
    let complete
    const t = setup({ chat: () => new Promise(r => { complete = r }), config: { autoPlusOneEnabled: false } })
    const running = t.bot.handleMessage(t.event('以前话题'))
    await new Promise(setImmediate)
    assert.ok(complete); t.timeline.end(); t.advance(1000); t.timeline.begin(); complete('迟到回复')
    await running; assert.equal(t.sent.length, 0)
    assert.ok(!t.memory.get(`g${group}`).some(m => m.role === 'assistant'))
  })
  await test('群里新话题到达，取消上一条仍在生成的主动插话；旧补发不会取消新消息', async () => {
    const completions = []
    const t = setup({ chat: () => new Promise(r => completions.push(r)), config: { autoPlusOneEnabled: false } })
    const first = t.bot.handleMessage(t.event('旧话题'))
    await new Promise(setImmediate)
    const second = t.bot.handleMessage(t.event('新话题'))
    await new Promise(setImmediate)
    await t.bot.handleMessage(t.event('补发背景', { time: t.time() / 1000 - 3600 }))
    completions[0]('旧回应'); completions[1]('新回应'); await Promise.all([first, second])
    assert.deepEqual(t.sent, ['新回应'])
  })
  await test('稳定连接中延迟超过 90 秒的事件不回应，未超龄的事件照常', async () => {
    const t = setup({ config: { autoPlusOneEnabled: false } }); t.advance(120_000)
    await t.bot.handleMessage(t.event('超龄', { time: t.time() / 1000 - 91 }))
    await t.bot.handleMessage(t.event('当前', { time: t.time() / 1000 - 10 }))
    assert.equal(t.sent.length, 1); assert.equal(t.requests.length, 1)
  })
  await test('盯人队列跳过历史、过期及旧登录会话，不在解禁或恢复后补答', async () => {
    const t = setup(), sent = [], prompts = []
    const watch = createTargetWatch({ config: { ...t.cfg, targetWatchEnabled: true, targetWatchGroup: group, targetWatchUser: user },
      logger, onebot: { ...t.onebot, sendGroup: async (_, msg) => sent.push(msg) }, memory: t.memory,
      llm: { chat: async (prompt) => { prompts.push(prompt); return '当前回应' } }, buildSystemPrompt: () => '聊天' })
    watch.note(t.event('旧', { time: t.time() / 1000 - 3600 }), { text: '旧' }); assert.equal(watch.pendingCount(), 0)
    watch.note(t.event('当时新'), { text: '当时新' }); t.advance(91_000); await watch.tick()
    assert.equal(watch.pendingCount(), 0); assert.equal(sent.length, 0)
    watch.note(t.event('重新登录前'), { text: '重新登录前' }); t.timeline.end(); t.advance(1000); t.timeline.begin(); await watch.tick()
    assert.equal(watch.pendingCount(), 0); assert.equal(sent.length, 0)
    watch.note(t.event('当前'), { text: '当前' }); await watch.tick(); assert.equal(sent.length, 1)
    assert.match(prompts[0], /明确表达现实担心、拒绝或不适时，再认真回应/)
    assert.equal(t.memory.get(`g${group}`).at(-1).replyToUserId, String(user))
  })
  await test('盯人生成期间断线，旧回复不发；生成期间的新消息不被整队清空', async () => {
    const t = setup(), sent = []; let complete
    const watch = createTargetWatch({ config: { ...t.cfg, targetWatchEnabled: true, targetWatchGroup: group, targetWatchUser: user },
      logger, onebot: { ...t.onebot, sendGroup: async (_, msg) => sent.push(msg) }, memory: t.memory,
      llm: { chat: () => new Promise(r => { complete = r }) }, buildSystemPrompt: () => '聊天' })
    watch.note(t.event('旧窗口'), { text: '旧窗口' }); const running = watch.tick()
    t.timeline.end(); t.advance(1000); t.timeline.begin()
    watch.note(t.event('新窗口'), { text: '新窗口' }); complete('旧回应'); await running
    assert.equal(sent.length, 0); assert.equal(watch.pendingCount(), 1)
  })
  await test('OneBot 同一 WebSocket 离线再上线也更新会话边界，原事件消息时间仍保留', async () => {
    const Original = globalThis.WebSocket; let socket
    class FakeSocket extends EventTarget {
      static OPEN = 1
      constructor() { super(); socket = this; this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      send(raw) { const p = JSON.parse(raw); queueMicrotask(() => this.message({ echo: p.echo, status: 'ok',
        data: p.action === 'get_login_info' ? { user_id: Number(selfId), nickname: '测试' } : { online: true, good: true } })) }
      message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
      close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })) }
    }
    globalThis.WebSocket = FakeSocket
    const ob = new OneBotClient({ url: 'ws://test', logger })
    try {
      const ready = new Promise(r => ob.once('ready', r)), running = ob.run(); await ready
      const oldSession = ob.messageTimeline.session
      socket.message({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: false } })
      assert.equal(ob.messageTimeline.available, false)
      socket.message({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true } })
      assert.ok(ob.messageTimeline.session > oldSession)
      const result = new Promise(r => ob.once('message', r)), time = Math.floor(Date.now() / 1000) - 60
      socket.message({ post_type: 'message', message_type: 'group', group_id: group, user_id: user, time })
      const evt = await result; assert.equal(evt.time, time); assert.equal(evt.messageContext.historical, true)
      ob.stop(); await running
    } finally { ob.stop(); globalThis.WebSocket = Original }
  })
  console.log(`${passed} cases passed`)
} finally {
  for (const memory of stores) if (memory.timer) clearTimeout(memory.timer)
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(dir).startsWith('koukou-freshness-'))
  rmSync(dir, { recursive: true, force: true })
}
