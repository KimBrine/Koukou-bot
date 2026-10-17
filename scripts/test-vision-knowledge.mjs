// 离线模拟参考图和模型，不调用付费模型或发送 QQ 消息。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadVisionKnowledge, createGroundedVisionClient, parseVisualComparison } from '../src/visionKnowledge.js'
import { createBot } from '../src/bot.js'
const root = mkdtempSync(path.join(tmpdir(), 'koukou-vision-knowledge-'))
const folder = path.join(root, 'vision-knowledge'); mkdirSync(folder)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64')
const part = { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }
const logger = { info() {}, warn() {}, debug() {}, error() {} }
const rules = { characters: [{ name: '角色甲', aliases: ['甲角色'] }, { name: '角色乙' }], prompt: '比较头饰和服装，不仅凭发色判断',
  cues: ['金色头饰'], references: [{ name: '角色甲', file: 'a.png' }, { name: '角色乙', file: 'b.png' }], exact: {} }
for (const file of ['a.png', 'b.png']) writeFileSync(path.join(folder, file), png)
const save = value => writeFileSync(path.join(folder, 'rules.json'), JSON.stringify(value))
save(rules)
const knowledge = loadVisionKnowledge(root, logger)
let passed = 0
async function test(name, task) { await task(); console.log(`PASS ${name}`); passed++ }
const confirmed = JSON.stringify({ description: '灰发角色戴金色头饰，衣服有菱形纹样', identities: [
  { image: 1, name: '角色甲', confidence: 'high', evidence: ['弯月状头饰', '菱形服装纹样'] }] })
try {
  await test('无本地资料时使用原客户端；非法参考路径被拒绝，规则或图片变化更新缓存版本', () => {
    const original = {}; assert.equal(createGroundedVisionClient(original, null, logger), original)
    assert.equal(loadVisionKnowledge(root + '-missing', logger), null)
    save({ ...rules, references: [{ name: '角色甲', file: '../a.png' }] }); assert.equal(loadVisionKnowledge(root, logger), null)
    save({ ...rules, prompt: '更新对照特征' }); assert.notEqual(loadVisionKnowledge(root, logger).version, knowledge.version)
    save(rules); writeFileSync(path.join(folder, 'b.png'), Buffer.concat([png, Buffer.from('changed')]))
    assert.notEqual(loadVisionKnowledge(root, logger).version, knowledge.version)
    writeFileSync(path.join(folder, 'b.png'), png)
  })
  await test('新图片先客观读取，再独立使用参考图比对，初次错误姓名不作为依据', async () => {
    const calls = [], client = { baseUrl: 'https://example.invalid', model: 'vision', async describeImages(...args) {
      calls.push(args); return calls.length === 1 ? '角色乙，灰发金色头饰' : confirmed } }
    const reader = createGroundedVisionClient(client, knowledge, logger)
    const description = await reader.describeImages('只描述目标', '这是什么', [part])
    assert.match(description, /【角色已确认：角色甲】/); assert.equal(calls.length, 2)
    assert.equal(calls[0][2].length, 1)
    assert.equal(calls[1][2].filter(p => p.type === 'image_url').length, 3)
    assert.match(calls[1][1], /忽略初次猜测/)
    assert.equal(calls[1][3].maxTokens, 650); assert.ok(calls[1][3].signal)
  })
  await test('无关图片只调用一次，不强行归入已知角色', async () => {
    let calls = 0; const reader = createGroundedVisionClient({ async describeImages() { calls++; return '黄色警察卡通表情' } }, knowledge, logger)
    assert.equal(await reader.describeImages('', '', [part]), '黄色警察卡通表情'); assert.equal(calls, 1)
  })
  await test('证据不足、候选外角色或解析失败不确认身份；比对异常保留画面而非误报加载失败', async () => {
    for (const row of [{ name: '角色甲', confidence: 'low', evidence: ['头饰细节', '服装细节'] },
      { name: '角色甲', confidence: 'high', evidence: ['灰头发'] },
      { name: '其他角色', confidence: 'high', evidence: ['头饰细节', '服装细节'] }]) {
      const result = parseVisualComparison(JSON.stringify({ description: '角色乙造型', identities: [{ image: 1, ...row }] }), knowledge, 1)
      assert.match(result, /角色身份未确认/); assert.ok(!result.includes('角色乙'))
    }
    assert.equal(parseVisualComparison('不是JSON', knowledge, 1), null)
    let calls = 0; const reader = createGroundedVisionClient({ async describeImages() {
      if (++calls === 1) return '角色乙，金色头饰'; throw Error('比对超时') } }, knowledge, logger)
    const result = await reader.describeImages('', '', [part]); assert.match(result, /身份未确认/)
    assert.match(result, /金色头饰/); assert.ok(!result.includes('角色乙')); assert.ok(!result.includes('加载失败'))
  })
  await test('人工哈希标注直接命中，不依赖易过期的模型描述缓存', async () => {
    const h = createHash('sha256').update(png).digest('hex')
    const local = { ...knowledge, exact: { [h]: { name: '角色甲', description: '金色冠饰，已人工核对' } } }
    const reader = createGroundedVisionClient({ describeImages() { throw Error('不应调用模型') } }, local, logger)
    assert.match(await reader.describeImages('', '', [part]), /角色已确认：角色甲/)
  })
  await test('聊天不自行补出未确认姓名；允许确认姓名、纠错否定和普通外观评论', () => {
    const reader = createGroundedVisionClient({}, knowledge, logger)
    assert.equal(reader.guardReply('这是角色乙呀', '【角色已确认：角色甲】金色冠饰'), '这是角色甲呀')
    assert.equal(reader.guardReply('这不是角色乙，是角色甲', '【角色已确认：角色甲】金色冠饰'), '这不是角色乙，是角色甲')
    assert.equal(reader.guardReply('这是角色甲', '【角色身份未确认】灰发'), '这张我还没认准角色，先不乱猜啦')
    assert.equal(reader.guardReply('小表情很有戏', '灰发'), '小表情很有戏')
  })
  await test('真实聊天路径隔离参考图、更新缓存范围，拦下聊天模型的错误角色名', async () => {
    const reader = createGroundedVisionClient({ baseUrl: 'https://example.invalid', model: 'vision' }, knowledge, logger)
    const sent = [], memory = [], scopes = []
    const bot = createBot({ config: { whitelistGroups: new Set([200000002]), mutedGroups: new Set(), quietHours: '',
      autoPlusOneEnabled: false, proactiveRate: 0, contextRememberAll: true, visionMaxImages: 2,
      replyMaxLines: 1, replyLineMaxChars: 40, humanDelayMinMs: 0, humanDelayMaxMs: 0, emojiKeepRate: 0 }, logger,
      onebot: { selfId: '200000010', async sendGroup(g, text) { sent.push(text); return { message_id: 2 } } },
      memory: { get() { return memory }, push(k, role, content, meta) { memory.push({ role, content, ...meta }) } },
      imageCache: { async load() { return { hash: 'a'.repeat(64), part } }, async describe(hashes, scope) {
        scopes.push(scope); return '【角色已确认：角色甲】金色冠饰，红色晶饰' } },
      visionLLM: reader, llm: { async chat() { return '这不是角色乙嘛，太可爱了' } }, buildSystemPrompt: () => '聊天人设' })
    await bot.handleMessage({ post_type: 'message', message_type: 'group', group_id: 200000002, user_id: 200000011,
      message_id: 1, time: Date.now() / 1000, sender: { nickname: '群友' }, message: [
        { type: 'at', data: { qq: '200000010' } }, { type: 'text', data: { text: '这是谁' } },
        { type: 'image', data: { file: 'abc.jpg', url: 'https://example.invalid/image.jpg' } }] })
    assert.equal(sent.length, 1); assert.match(sent[0], /角色甲/); assert.ok(!sent[0].includes('角色乙'))
    assert.ok(scopes[0].includes(knowledge.version)); assert.equal(memory.filter(m => m.role === 'user').length, 1)
    assert.ok(!memory[0].content.includes('参考图')); assert.ok(!memory[0].content.includes('data:image'))
  })
  console.log(`${passed} cases passed`)
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
  assert.ok(path.basename(root).startsWith('koukou-vision-knowledge-')); rmSync(root, { recursive: true, force: true })
}
