// 临时目录与模拟历史：白名单手动总结存档、可见边界及失败通知，不连接 QQ 或模型。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import { createDailySummary } from '../src/dailySummary.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'koukou-summary-capture-'))
const logger = { info() {}, warn() {}, error() {} }
const config = { dataDir: dir, summaryEnabled: true, summaryGroups: [101], whitelistGroups: new Set([101, 102]),
  summaryMaxMessages: 600, summaryMaxBlocks: 20, summaryUserRows: 20, summarySendMode: 'forward', botName: '测试机器人' }
mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-16T23:00:00+08:00').getTime() })
const now = Math.floor(Date.now() / 1000), start = new Date('2026-10-16T00:00:00+08:00').getTime() / 1000
const packet = (id, time) => ({ message_id: id, message_seq: id, time, user_id: 123, sender: { nickname: '甲' }, message: '群内真实消息' })
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }
try {
  await test('显式定时目标不影响其他白名单群的实时存档，不扩大自动总结范围', () => {
    const summary = createDailySummary({ config, logger, onebot: { selfId: '999' }, llm: null })
    const capture = (id, group, user = 123) => summary.capture({ message_type: 'group', group_id: group, user_id: user, message_id: id, time: now - 1 },
      { text: '真实消息', replyId: '5', forwards: [{ type: 'forward', data: { id: 'card' } }] })
    capture(1, 102); capture(2, '102'); capture(3, 555); capture(4, 102, 999)
    assert.equal(summary.countCaptured(102), 2); assert.equal(summary.countCaptured(555), 0)
    assert.deepEqual(summary.summaryGroups(), [101])
    const rows = readFileSync(path.join(dir, 'daily', '102', '2026-10-16.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows[0].replyId, '5'); assert.equal(rows[0].forwards[0].data.id, 'card')
    assert.equal(rows[0].text, '真实消息')
    config.whitelistGroups.add(103); capture(6, 103); assert.equal(summary.countCaptured(103), 1)
    assert.equal(existsSync(path.join(dir, 'daily', '555')), false)
  })
  await test('历史停在当日可见边界时三轮结束，明确提示；不调用模型、不伪造全天报告', async () => {
    let rounds = 0, models = 0, cards = 0; const notices = []
    const messages = [packet(1, now - 600), packet(2, now - 60)]
    const summary = createDailySummary({ config, logger,
      onebot: { selfId: '999', async getGroupMsgHistory(id, seq) { if (seq == null) rounds++; return { messages } },
        async sendGroup(id, text) { notices.push(text) }, async sendGroupForward() { cards++ } },
      llm: { async chat() { models++; throw Error('不能生成残缺总结') } } })
    await summary.runSummary(102)
    assert.equal(rounds, 3); assert.equal(models, 0); assert.equal(cards, 0)
    assert.equal(notices.length, 1); assert.match(notices[0], /最早只能读到 10-16 22:50/)
    assert.match(notices[0], /未能生成/); assert.match(notices[0], /10-16 00:00/)
    assert.equal(summary.isRunning(102), false)
    rounds = 0; notices.length = 0
    const preview = await summary.previewStats(102)
    assert.equal(rounds, 3); assert.equal(preview.complete, false); assert.equal(preview.reason, 'start_not_reached')
    assert.equal(preview.earliestSec, messages[0].time); assert.equal(notices.length, 0)
    await summary.runSummary(102, { dryRun: true }); assert.equal(notices.length, 0)
  })
  await test('新补齐旧记录时不提前停止，达到起点并稳定后仍可确认完整', async () => {
    let round = 0
    const summary = createDailySummary({ config, logger, llm: null, onebot: { selfId: '999', async getGroupMsgHistory(id, seq) {
      if (seq == null) round++
      return { messages: round < 3 ? [packet(2, now - 60)] : [packet(1, start - 10), packet(3, start + 10), packet(2, now - 60)] }
    } } })
    const preview = await summary.previewStats(102)
    assert.equal(preview.complete, true); assert.equal(round, 4); assert.equal(preview.reason, '')
  })
  await test('接口失败有明确原因；提示发送失败不把群锁留在运行中', async () => {
    let notices = 0
    const summary = createDailySummary({ config, logger, llm: null, onebot: { selfId: '999',
      async getGroupMsgHistory() { throw Error('接口超时') }, async sendGroup() { notices++; throw Error('发送失败') } } })
    assert.equal((await summary.previewStats(102)).reason, 'api_failed')
    await summary.runSummary(102); assert.equal(notices, 1); assert.equal(summary.isRunning(102), false)
  })
  console.log(`${passed} cases passed`)
} finally {
  mock.timers.reset()
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(dir).startsWith('koukou-summary-capture-')); rmSync(dir, { recursive: true, force: true })
}
