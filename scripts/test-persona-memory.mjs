// 全部使用临时目录、模型与 QQ 替身，不读取部署聊天或实际切换人格。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/memory.js'
import { createLongMemory } from '../src/longMemory.js'
import { activatePersona } from '../src/personaSwitch.js'
import { createChatPromptBuilder } from '../src/chatPrompt.js'
import { createAdminServer } from '../src/admin/server.js'
import { createBot } from '../src/bot.js'
import { createTargetWatch } from '../src/targetWatch.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-persona-memory-'))
const logger = { info() {}, warn() {}, error() {}, debug() {} }, stores = []
let sequence = 0, passed = 0
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`) }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(llm = { async chat() { return '偏好：群友甲喜欢蓝色。约定：周六去公园。' } }) {
  const dir = path.join(root, String(++sequence)); mkdirSync(dir)
  const memory = new MemoryStore({ file: path.join(dir, 'memory.json'), limit: 3, logger }); stores.push(memory)
  const file = path.join(dir, 'long-memory.json')
  const longMemory = createLongMemory({ file, logger, llm, maxBatch: 60 })
  memory.onEvict = (key, items) => longMemory.addEvicted(key, items)
  const config = { dataDir: dir, rootDir: dir, persona: '你是严肃的甲。', activePersona: '甲', longMemoryEnabled: true,
    whitelistGroups: new Set([200000002]), mutedGroups: new Set(), quietHours: '', autoPlusOneEnabled: false,
    proactiveRate: 0, contextRememberAll: true, replyMaxLines: 1, replyLineMaxChars: 40, replyLengthMatch: false,
    humanDelayMinMs: 0, humanDelayMaxMs: 0, lineGapMinMs: 0, lineGapMaxMs: 0, emojiKeepRate: 0 }
  const switchTo = (name = '乙', content = '你是冷静的乙。', persist = () => {}) => activatePersona({ name, content, config, memory, longMemory, persist })
  return { dir, file, memory, longMemory, config, switchTo }
}
function chatFixture(t, llm) {
  const sent = [], onebot = { selfId: '200000010', async sendGroup(id, text) { sent.push(text); return { message_id: 90 } },
    async sendPrivate(id, text) { sent.push(text); return { message_id: 90 } } }
  const buildSystemPrompt = createChatPromptBuilder({ config: t.config, longMemory: t.longMemory })
  return { onebot, sent, buildSystemPrompt, bot: createBot({ ...t, logger, onebot, llm, buildSystemPrompt, rand: () => 0.5 }) }
}
const event = () => ({ post_type: 'message', message_type: 'group', group_id: 200000002, user_id: 200000011,
  message_id: Math.random(), time: Date.now() / 1000, sender: { nickname: '群友甲' },
  message: [{ type: 'at', data: { qq: '200000010' } }, { type: 'text', data: { text: '公园约定是哪天呀' } }] })
try {
  await test('真实切换备份并清空全部会话；原始日报与人格库保留', async () => {
    const t = fixture()
    t.memory.push('g1', 'assistant', '旧语气'); t.memory.push('p2', 'user', '旧约定')
    t.longMemory.addEvicted('g1', [{ text: '旧人格的约定', time: 1000 }]); await t.longMemory.summarize('g1')
    writeFileSync(path.join(t.dir, 'daily.jsonl'), '保留原记录'); mkdirSync(path.join(t.dir, 'personas')); writeFileSync(path.join(t.dir, 'personas', '甲.txt'), '保留人格')
    const result = t.switchTo()
    assert.equal(result.changed, true); assert.equal(result.reset.chats, 2); assert.equal(result.reset.longChats, 1)
    assert.equal(t.config.personaRevision, 1); assert.equal(t.memory.chats.size, 0); assert.deepEqual(t.longMemory.stats(), [])
    const backup = JSON.parse(readFileSync(path.join(t.dir, 'config-backups', readdirSync(path.join(t.dir, 'config-backups'))[0]), 'utf8'))
    assert.equal(backup.recent.chats.g1[0].content, '旧语气'); assert.match(backup.long.chats.g1.summary, /蓝色/)
    assert.equal(readFileSync(path.join(t.dir, 'daily.jsonl'), 'utf8'), '保留原记录')
    assert.equal(readFileSync(path.join(t.dir, 'personas', '甲.txt'), 'utf8'), '保留人格')
    assert.deepEqual(JSON.parse(readFileSync(t.memory.file, 'utf8')), {})
  })
  await test('同名修改正文不清记忆；换名字才建立新边界', () => {
    const t = fixture(); t.memory.push('g1', 'user', '保留')
    assert.equal(t.switchTo('甲', t.config.persona).changed, false); assert.equal(t.memory.get('g1').length, 1)
    // 同一个名字：只改正文，不重置
    assert.equal(t.switchTo('甲', '甲的新版本').changed, false); assert.equal(t.memory.get('g1').length, 1)
    // 换名字：新人格有自己的记忆分区
    assert.equal(t.switchTo('乙', '乙的正文').changed, true); assert.equal(t.memory.get('g1').length, 0)
    assert.throws(() => t.switchTo('无效', '   '), /不能为空/)
  })
  await test('持久化失败恢复近期、长期及检索分区；备份失败不会开始清理', async () => {
    const t = fixture(); t.memory.push('g1', 'user', '保留原话')
    t.longMemory.addEvicted('g1', [{ text: '公园约定是周六见面', time: 1000 }]); await t.longMemory.summarize('g1')
    const recent = t.memory.snapshot(), long = t.longMemory.snapshot()
    assert.throws(() => t.switchTo('乙', '乙', () => { throw Error('模拟写入失败') }), /原记忆已保留/)
    assert.deepEqual(t.memory.snapshot(), recent); assert.deepEqual(t.longMemory.snapshot(), long)
    assert.equal(t.config.activePersona, '甲'); assert.equal(t.config.personaRevision, undefined)
    const blocker = path.join(t.dir, 'blocker'); writeFileSync(blocker, '文件不是目录'); t.config.dataDir = blocker
    assert.throws(() => t.switchTo()); assert.deepEqual(t.memory.snapshot(), recent)
  })
  await test('重启仍隔离旧登录补读；切换后新消息可以正常记忆', () => {
    const t = fixture(); t.switchTo()
    const restored = new MemoryStore({ file: t.memory.file, limit: 3, logger }); stores.push(restored); restored.load()
    assert.equal(restored.push('g1', 'user', '旧发言', { time: 1, historical: true }), false)
    assert.equal(restored.push('g1', 'user', '未知时间补读', { time: null, historical: true }), false)
    assert.equal(restored.push('g1', 'user', '新发言', { time: restored.resetAt + 1000 }), true)
    assert.equal(restored.push('g1', 'user', '同一秒的新发言', { time: restored.resetAt }), true)
    assert.equal(restored.get('g1').length, 2)
  })
  await test('旧压缩请求和历史回填不能在切换后复活旧记忆', async () => {
    const d = deferred(), entered = deferred()
    const t = fixture({ async chat() { entered.resolve(); return d.promise } })
    const feed = t.longMemory.feed('g1', [{ text: '旧公园约定' }, { text: '不能继续回填' }], { batchSize: 1 })
    await entered.promise; t.switchTo(); d.resolve('这是已失效的摘要')
    assert.equal(await feed, false); assert.deepEqual(t.longMemory.stats(), [])
    assert.equal(t.longMemory.get('g1', { query: '旧公园约定' }), '')
    assert.deepEqual(createLongMemory({ file: t.file, logger }).stats(), [])
  })
  await test('压缩并发合并一次，期间到来的新原话保留在待处理队列', async () => {
    let calls = 0; const d = deferred(), t = fixture({ async chat() { calls++; return d.promise } })
    t.longMemory.addEvicted('g1', [{ text: '第一条' }])
    const a = t.longMemory.summarize('g1'), b = t.longMemory.summarize('g1')
    t.longMemory.addEvicted('g1', [{ text: '第二条' }]); d.resolve('记住第一条')
    assert.equal(await a, true); assert.equal(await b, true); assert.equal(calls, 1)
    assert.equal(t.longMemory.snapshot().chats.g1.pending[0].text, '第二条')
  })
  await test('失败或超长摘要不覆盖旧记忆，也不删除队列原文', async () => {
    const t = fixture({ async chat() { return '字'.repeat(1501) } })
    t.longMemory.addEvicted('g1', [{ text: '完整待处理原话' }])
    assert.equal(await t.longMemory.summarize('g1'), false)
    assert.equal(t.longMemory.snapshot().chats.g1.pending[0].text, '完整待处理原话')
    assert.equal(t.longMemory.get('g1'), '')
  })
  await test('超出150字的关键细节仍归档、检索并在重启后可找回；群之间隔离', async () => {
    let input = ''; const t = fixture({ async chat(p, messages) { input = messages[0].content; return '摘要没有记下那条约定' } })
    const text = '背景铺垫。'.repeat(40) + '公园约定：星期六下午四点在东门集合。'
    t.memory.push('g1', 'user', text, { time: 1000, senderName: '群友甲', userId: '200000011', messageId: '1' })
    for (let i = 0; i < 3; i++) t.memory.push('g1', 'user', `新消息${i}`, { time: 2000 + i })
    await t.longMemory.summarize('g1'); assert.match(input, /星期六下午四点/)
    assert.match(t.longMemory.get('g1', { query: '公园约定什么时候集合' }), /星期六下午四点/)
    assert.equal(t.longMemory.get('g2', { query: '公园约定' }), '')
    assert.equal(t.longMemory.get('g1', { query: '完全无关的考试' }), '摘要没有记下那条约定')
    const restored = createLongMemory({ file: t.file, logger }); assert.match(restored.get('g1', { query: '公园约定' }), /群友甲.*星期六下午四点/)
    const before = t.longMemory.snapshot(); t.switchTo(); assert.equal(t.longMemory.get('g1', { query: '公园约定' }), '')
    t.longMemory.restore(before); assert.match(t.longMemory.get('g1', { query: '公园约定' }), /星期六下午四点/)
  })
  await test('原文存储失败时近期窗口保留溢出消息，重启不裁掉未归档数据', () => {
    const t = fixture(); t.memory.onEvict = () => { throw Error('磁盘故障') }
    for (let i = 0; i < 5; i++) t.memory.push('g1', 'user', `消息${i}`)
    assert.equal(t.memory.get('g1').length, 5); t.memory.flush()
    const restored = new MemoryStore({ file: t.memory.file, limit: 3, logger }); stores.push(restored); restored.load()
    assert.equal(restored.get('g1').length, 5)
  })
  await test('提示词动态切换默认与自定义人格，通用规则不再强制原名字和可爱语气', () => {
    const t = fixture(); t.config.persona = ''; const build = createChatPromptBuilder({ ...t, todayNote: () => '\n今日已办' })
    assert.match(build({ chatKey: 'g1' }), /聊天助手/)
    t.config.persona = '你是机器人乙，自称在下，严肃简洁。'
    const prompt = build({ chatKey: 'g1' }); assert.match(prompt, /你是机器人乙/); assert.match(prompt, /今日已办/)
    assert.doesNotMatch(prompt, /小口口子|小男娘|可以叫群友宝宝|呀、啦、嘛/)
  })
  await test('旧人格生成中的普通回复被取消，新人格下一条正常回复', async () => {
    const t = fixture(), d = deferred(), entered = deferred(); let calls = 0
    const c = chatFixture(t, { async chat() { if (++calls === 1) { entered.resolve(); return d.promise } return '乙已接话' } })
    const task = c.bot.handleMessage(event()); await entered.promise; t.switchTo(); d.resolve('甲的旧回复'); await task
    assert.deepEqual(c.sent, []); assert.equal(t.memory.get('g200000002').length, 0)
    await c.bot.handleMessage(event()); assert.deepEqual(c.sent, ['乙已接话'])
    assert.equal(t.memory.get('g200000002').at(-1).content, '乙已接话')
  })
  await test('发送回执期间切换，不把已发送旧人格内容写入新人格记忆', async () => {
    const t = fixture(), c = chatFixture(t, { async chat() { return '旧人格的答复' } })
    c.onebot.sendGroup = async () => { t.switchTo(); return { message_id: 90 } }
    await c.bot.handleMessage(event()); assert.equal(t.memory.get('g200000002').length, 0)
  })
  await test('盯人排队和生成中的旧人格回复均取消', async () => {
    const t = fixture(), d = deferred(), entered = deferred(), c = chatFixture(t, {})
    Object.assign(t.config, { targetWatchEnabled: true, targetWatchGroup: 200000002, targetWatchUser: 200000011 })
    const watch = createTargetWatch({ ...t, logger, onebot: c.onebot, buildSystemPrompt: c.buildSystemPrompt,
      llm: { async chat() { entered.resolve(); return d.promise } } })
    watch.note(event(), { text: '原来的话题', atBot: false }); const task = watch.tick(); await entered.promise
    activatePersona({ ...t, name: '乙', content: '乙', targetWatch: watch, persist() {} }); d.resolve('甲的回复'); await task
    assert.equal(watch.pendingCount(), 0); assert.deepEqual(c.sent, []); assert.equal(t.memory.get('g200000002').length, 0)
  })
  await test('控制台保存草稿不改变正在使用的人格；激活走备份重置流程', async () => {
    const t = fixture(); t.config.envFile = path.join(t.dir, '.env'); writeFileSync(t.config.envFile, 'ACTIVE_PERSONA=甲\nUNRELATED=keep\n')
    const admin = createAdminServer({ ...t, logger })
    try {
      t.memory.push('g1', 'user', '旧消息')
      await admin.actions['save-persona']({ name: '甲', content: '修改的甲' })
      assert.equal(t.config.persona, '你是严肃的甲。'); assert.equal(t.memory.get('g1').length, 1)
      const r = await admin.actions['activate-persona']({ name: '甲' }); assert.equal(r.changed, false)
      assert.equal(t.config.persona, '修改的甲'); assert.equal(t.memory.get('g1').length, 1)
      assert.match(readFileSync(t.config.envFile, 'utf8'), /UNRELATED=keep/)
      await assert.rejects(admin.actions['activate-persona']({ name: '不存在' }), /不存在/)
    } finally { admin.server.close() }
  })
  console.log(`${passed} cases passed`)
} finally {
  for (const store of stores) { if (store.timer) clearTimeout(store.timer); store.flush() }
  assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('koukou-persona-memory-'))
  rmSync(root, { recursive: true, force: true })
}
