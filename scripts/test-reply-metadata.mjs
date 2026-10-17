// 模型、QQ 和记忆均用离线替身；不调用外部服务。
import assert from 'node:assert/strict'
import { stripInternalReplyMetadata } from '../src/replySanitizer.js'
import { modelHistory } from '../src/memory.js'
import { createBot } from '../src/bot.js'
import { createTargetWatch } from '../src/targetWatch.js'
const logger = { info() {}, warn() {}, error() {}, debug() {} }
let passed = 0
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`) }
const config = { whitelistGroups: new Set([200000002]), mutedGroups: new Set(), quietHours: '', autoPlusOneEnabled: false,
  proactiveRate: 0, contextRememberAll: true, replyMaxLines: 1, replyLineMaxChars: 40, replyLengthMatch: false,
  humanDelayMinMs: 0, humanDelayMaxMs: 0, lineGapMinMs: 0, lineGapMaxMs: 0, emojiKeepRate: 0 }
const event = type => ({ post_type: 'message', message_type: type, user_id: 200000011, group_id: 200000002,
  message_id: 1, time: Date.now() / 1000, sender: { nickname: '群友甲' }, message: [
    { type: 'at', data: { qq: '200000010' } }, { type: 'text', data: { text: '你觉得呢' } }] })
function setup(outputs) {
  const sent = [], history = [], requests = []
  const memory = { get() { return history }, push(k, role, content, meta) { history.push({ role, content, ...meta }) } }
  const onebot = { selfId: '200000010', async sendGroup(g, content) { sent.push(content); return { message_id: 2 } },
    async sendPrivate(u, content) { sent.push(content); return { message_id: 2 } } }
  const llm = { async chat(...args) { requests.push(args); return outputs.shift() } }
  const bot = createBot({ config, logger, onebot, memory, llm, rand: () => 0.5, buildSystemPrompt: () => '聊天' })
  return { bot, sent, history, requests, memory, onebot, llm }
}
await test('完整、半截、重复及夹在正文中的内部标记被移除，带括号的昵称不误截正文', () => {
  const cases = [
    ['【此前回复对象："群友甲"，用户标识 200000011】你好呀', '你好呀'],
    ['[此前回复对象:"群友甲"]你好呀', '你好呀'],
    ['【此前回复对象："甲】乙"，用户标识 200000011】你好呀', '你好呀'],
    ['【此前回复对象："甲\\\"乙"】你好呀', '你好呀'],
    ['【此前回复对象："群友甲"QAQ', ''],
    ['【此前回复对象', ''],
    ['【此前回复对象："群友甲"\n正文还在呀', '正文还在呀'],
    ['【此前回复对象："群友甲"】QAQ', ''],
    ['前一句【角色已确认：角色甲】后一句', '前一句后一句'],
    ['【角色身份未确认】【历史消息 2026-01-01】正文', '正文'],
    ['【对话关系备注：第2条机器人回复"甲"】正文', '正文'],
    ['此前回复对象："群友甲"\n正文', '正文'],
  ]
  for (const [raw, clean] of cases) assert.equal(stripInternalReplyMetadata(raw), clean, raw)
})
await test('普通方括号标题、QQ表情、CQ段、独立颜文字和换行不被当作内部标记', () => {
  for (const raw of ['【活动通知】明天见', '[表情:微笑]', '[CQ:face,id=14]', 'QAQ', '(=^▽^=)', '你好\n明天见']) {
    assert.equal(stripInternalReplyMetadata(raw), raw)
  }
  assert.equal(stripInternalReplyMetadata('QAQ\r\nQAQ'), 'QAQ\nQAQ')
})
await test('回复关系仍可读，但助手示例只含正文，旧污染记录不再作为模仿样例', () => {
  const raw = [{ role: 'user', content: '周末去吗', time: Date.now(), userId: '200000011', senderName: '群友甲' },
    { role: 'assistant', content: '【此前回复对象："群友甲"QAQ', replyToName: '群友甲' },
    { role: 'assistant', content: '【此前回复对象："群友甲"】一起去呀', replyToName: '群友甲', replyToUserId: '200000011' }]
  const messages = modelHistory(raw)
  assert.equal(messages.length, 2); assert.match(messages[0].content, /第2条历史消息是机器人回复.*群友甲/)
  assert.equal(messages[1].content, '一起去呀'); assert.ok(messages.every(m => Object.keys(m).sort().join(',') === 'content,role'))
  assert.ok(raw[1].content.includes('此前回复对象')) // 持久化原话不被篡改。
})
await test('普通群聊和私聊均在长度裁剪前清理，发送和记忆只留下实际正文', async () => {
  for (const type of ['group', 'private']) {
    const t = setup(['【此前回复对象："群友甲"，用户标识 200000011】这是实际回答呀'])
    await t.bot.handleMessage(event(type))
    assert.deepEqual(t.sent, ['这是实际回答呀']); assert.equal(t.requests.length, 1)
    assert.equal(t.history.at(-1).content, t.sent[0]); assert.equal(t.history.at(-1).replyToUserId, 200000011)
  }
})
await test('只有内部标记时重生成一次；连续失败不发送标记、装饰残片或空回复', async () => {
  const good = setup(['【此前回复对象："群友甲"QAQ', '我在呀，继续说'])
  await good.bot.handleMessage(event('group'))
  assert.equal(good.requests.length, 2); assert.match(good.requests[1][0], /重新回答/)
  assert.deepEqual(good.sent, ['我在呀，继续说'])
  const bad = setup(['【此前回复对象："群友甲"】QAQ', '【对话关系备注：'])
  await bad.bot.handleMessage(event('group'))
  assert.equal(bad.requests.length, 2); assert.deepEqual(bad.sent, [])
  assert.equal(bad.history.filter(m => m.role === 'assistant').length, 0)
})
await test('盯人回复沿用相同清理与单次修复，不让失败批次重复生成', async () => {
  for (const second of ['继续聊呀', '【此前回复对象："群友甲"QAQ']) {
    const t = setup(['【此前回复对象："群友甲"QAQ', second])
    const watch = createTargetWatch({ config: { ...config, targetWatchEnabled: true,
      targetWatchGroup: 200000002, targetWatchUser: 200000011 }, logger, onebot: t.onebot, memory: t.memory,
      llm: t.llm, buildSystemPrompt: () => '聊天' })
    const evt = event('group'); watch.note(evt, { text: '今天好吗', atBot: false }); await watch.tick(); await watch.tick()
    assert.equal(t.requests.length, 2); assert.equal(watch.pendingCount(), 0)
    if (second === '继续聊呀') { assert.equal(t.sent.length, 1); assert.match(t.sent[0][1].data.text, /继续聊呀/) }
    else assert.equal(t.sent.length, 0)
  }
})
console.log(`${passed} cases passed`)
