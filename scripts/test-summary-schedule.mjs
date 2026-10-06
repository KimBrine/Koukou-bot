// 本地时钟、QQ 回执与历史模拟；不连接 QQ，不调用真实模型。
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSummarySchedule } from '../src/summarySchedule.js'
import { createDailySummary } from '../src/dailySummary.js'

const DAY = '2026-10-07'
const logger = { info() {}, warn() {}, error() {} }
const header = '🎯 群聊日常分析报告\n📅 2026年10月07日'
const clock = time => mock.timers.setTime(new Date(`${DAY}T${time}+08:00`).getTime())
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
let passed = 0
async function test(name, task) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(`${DAY}T23:00:00+08:00`).getTime() })
  try { await task(); console.log(`PASS ${name}`); passed++ } finally { mock.timers.reset() }
}
function fixture({ dir, history, action, groupIds = [101, 102], enabled = true } = {}) {
  const work = [], active = new Set(), reads = [], probes = []
  const env = { loggedIn: true }
  const config = { summaryEnabled: true, summaryFallbackEnabled: enabled, summaryTimes: ['23:00'], dataDir: dir }
  const onebot = { selfId: '999', async refreshStatus(opts) { probes.push(opts); return { connected: true, online: env.loggedIn } },
    async getForwardMsg(id) { if (id === 'fail') throw Error('timeout'); return { messages: [{ message: [{ type: 'text', data: { text: header } }] }] } } }
  let service
  service = createSummarySchedule({ config, logger, onebot, groups: () => groupIds, isRunning: id => active.has(id), pause: async () => {},
    readEveningHistory: async (id, start) => { reads.push({ id, start }); return typeof history === 'function' ? history(id) : history ?? { complete: true, rawMessages: [] } },
    runGroup: async (id, opts) => {
      work.push({ id, ...opts }); active.add(id)
      try {
        if (action) await action(id, opts, service, env)
        else service.acknowledged(service.beforeSend(id), { message_id: id + work.length })
      } finally { active.delete(id) }
    },
  })
  return { service, config, env, onebot, active, work, reads, probes }
}
const own = (raw, user = 999) => ({ message_id: 1, user_id: user, time: new Date(`${DAY}T23:04:00+08:00`).getTime() / 1000, message: raw })
const text = value => [{ type: 'text', data: { text: value } }]
const removeTemp = dir => {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(dir).startsWith('summary-schedule-'))
  rmSync(dir, { recursive: true, force: true })
}

await test('23:00 成功发送的每个群，23:30 不再生成或发送', async () => {
  const e = fixture(); await e.service.runSlot('23:00'); clock('23:30:00'); await e.service.runSlot('23:30')
  assert.deepEqual(e.work.map(x => x.id), [101, 102]); assert.equal(e.reads.length, 0)
  assert.ok(e.probes.every(x => x.maxAgeMs === 0 && x.forceProbe === true))
})
await test('只有 23:00 未发过的群补发，其他群不重发', async () => {
  const e = fixture({ action: async (id, opts, service) => { if (id === 101 || opts.scheduleTime === '23:30') service.acknowledged(service.beforeSend(id), { message_id: id }) } })
  await e.service.runSlot('23:00'); clock('23:30:00'); await e.service.runSlot('23:30')
  assert.deepEqual(e.work.map(x => [x.id, x.scheduleTime]), [[101, '23:00'], [102, '23:00'], [102, '23:30']])
  assert.deepEqual(e.reads.map(x => x.id), [102])
})
await test('23:00 未登录，23:30 恢复登录后确认未发再补一次', async () => {
  const e = fixture(); e.env.loggedIn = false; await e.service.runSlot('23:00'); assert.equal(e.work.length, 0)
  e.env.loggedIn = true; clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 2)
})
await test('两个时点都离线，当晚晚些登录也不追补', async () => {
  clock('22:59:59'); const e = fixture(); e.env.loggedIn = false; e.service.schedule()
  mock.timers.tick(1000); await flush(); mock.timers.tick(1800000); await flush()
  e.env.loggedIn = true; mock.timers.tick(600000); await flush(); assert.equal(e.work.length, 0); e.service.stop()
})
await test('23:00 任务仍在生成或排队时，23:30 不并发重复生成', async () => {
  let release
  const e = fixture({ action: async (id, opts, service) => { if (id === 101) await new Promise(resolve => { release = resolve }); service.acknowledged(service.beforeSend(id), { message_id: id }) } })
  const running = e.service.runSlot('23:00'); await flush(); clock('23:30:00'); await e.service.runSlot('23:30')
  assert.equal(e.work.length, 1); release(); await running; assert.equal(e.work.length, 2)
})
await test('手动总结正在执行，补发检查跳过该群', async () => {
  const e = fixture(); e.active.add(101); clock('23:30:00'); await e.service.runSlot('23:30'); assert.deepEqual(e.work.map(x => x.id), [102])
})
await test('同一时点重复回调、重复排期都只执行一次', async () => {
  clock('22:59:59'); const e = fixture(); e.service.schedule(); e.service.schedule()
  mock.timers.tick(1000); await flush(); await e.service.runSlot('23:00'); assert.equal(e.work.length, 2); e.service.stop()
})
await test('重启保留已发回执，只补失败的群', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'summary-schedule-'))
  try {
    const a = fixture({ dir, action: async (id, opts, service) => { if (id === 101) service.acknowledged(service.beforeSend(id), { message_id: id }) } })
    await a.service.runSlot('23:00'); clock('23:30:00'); const b = fixture({ dir }); await b.service.runSlot('23:30')
    assert.deepEqual(b.work.map(x => x.id), [102])
  } finally { removeTemp(dir) }
})
await test('没有本地回执时，QQ 历史发现普通报告则不补发', async () => {
  const e = fixture({ history: { complete: true, rawMessages: [own(text(header))] } }); clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 0)
})
await test('历史发现合并转发中的报告，即使首屏不完整也不会重发', async () => {
  const e = fixture({ history: { complete: false, rawMessages: [own([{ type: 'forward', data: { id: 'card' } }])] } })
  clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 0)
})
await test('CQ 格式的转发卡片和已展开的转发节点都能查到报告', async () => {
  for (const raw of ['[CQ:forward,id=card]', [{ type: 'forward', data: { content: [{ content: text(header) }] } }]]) {
    const e = fixture({ history: { complete: true, rawMessages: [own(raw)] } }); clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 0)
  }
})
await test('历史不完整、读取失败、卡片无法展开均不会冒险补发', async () => {
  for (const history of [{ complete: false, rawMessages: [] }, { complete: true }, { complete: true, rawMessages: [own([])] }, { complete: true, rawMessages: [own([{ type: 'json', data: { data: '{}' } }])] }, { complete: true, rawMessages: [own([{ type: 'forward', data: { id: 'fail' } }])] }, () => { throw Error('history timeout') }]) {
    const e = fixture({ history }); clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 0)
  }
})
await test('曾经发送超时且没收到回执，历史发现报告仍不重发', async () => {
  const e = fixture({ history: { complete: true, rawMessages: [own(text(header))] }, action: async (id, opts, service) => service.failed(service.beforeSend(id), Error('OneBot API 超时')) })
  await e.service.runSlot('23:00'); clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 2)
})
await test('曾经发送超时，即使暂未出现在历史中也不冒险重发', async () => {
  const e = fixture({ action: async (id, opts, service) => {
    const key = service.beforeSend(id)
    if (opts.scheduleTime === '23:00') service.failed(key, Error('timeout'))
    else service.acknowledged(key, { message_id: id })
  } })
  await e.service.runSlot('23:00'); clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 2)
})
await test('明确发送失败且完整历史确定未发，23:30 才允许重试', async () => {
  const e = fixture({ action: async (id, opts, service) => {
    const key = service.beforeSend(id)
    if (opts.scheduleTime === '23:00') service.failed(key, Error('OneBot API 失败：retcode=1200'))
    else service.acknowledged(key, { message_id: id })
  } })
  await e.service.runSlot('23:00'); clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 4)
})
await test('已发出部分报告或发现报告片段，均不重新发整份', async () => {
  const a = fixture(); a.service.acknowledged(a.service.beforeSend(101), { message_id: 99 })
  clock('23:30:00'); await a.service.runSlot('23:30'); assert.deepEqual(a.work.map(x => x.id), [102])
  const b = fixture({ history: { complete: true, rawMessages: [own(text('💬 热门话题\n1. 真实话题'))] } }); await b.service.runSlot('23:30'); assert.equal(b.work.length, 0)
})
await test('发送接口缺少消息编号时保持未确认，不假记成功', async () => {
  const e = fixture(); const key = e.service.beforeSend(101)
  assert.throws(() => e.service.acknowledged(key, {}), err => err.code === 'SUMMARY_SEND_UNCERTAIN')
  assert.equal(e.service.hasDelivered(DAY, 101), false)
})
await test('其他群友转发/复制报告，不冒充部署环境器人发送成功', async () => {
  const e = fixture({ history: { complete: true, rawMessages: [own(text(header), 123)] } }); clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 2)
})
await test('核对历史后 QQ 又掉线，不开始补发', async () => {
  let e; e = fixture({ history: () => { e.env.loggedIn = false; return { complete: true, rawMessages: [] } } })
  clock('23:30:00'); await e.service.runSlot('23:30'); assert.equal(e.work.length, 0)
})
await test('中途掉线后释放排队占位，23:30 恢复后只补未发的群', async () => {
  const e = fixture({ action: async (id, opts, service, env) => { service.acknowledged(service.beforeSend(id), { message_id: id }); env.loggedIn = false } })
  await e.service.runSlot('23:00'); assert.equal(e.work.length, 1); e.env.loggedIn = true; clock('23:30:00'); await e.service.runSlot('23:30')
  assert.deepEqual(e.work.map(x => x.id), [101, 102])
})
await test('23:45 重启不会追补，次日正常排期', async () => {
  clock('23:45:00'); const e = fixture(); e.service.schedule(); mock.timers.tick(3600000); await flush()
  assert.equal(e.work.length, 0); e.service.stop()
})
await test('电脑休眠错过时点一分钟以上，醒来不追补', async () => {
  clock('22:59:59'); const e = fixture(); e.service.schedule(); mock.timers.tick(121000); await flush()
  assert.equal(e.work.length, 0); e.service.stop()
})
await test('Windows 时钟向后校准不会让任务提前执行', async () => {
  clock('22:59:59'); const e = fixture(); e.service.schedule(); clock('22:59:00'); mock.timers.tick(1000); await flush(); assert.equal(e.work.length, 0)
  mock.timers.tick(59000); await flush(); assert.equal(e.work.length, 2); e.service.stop()
})
await test('关闭每日报告不会排补发任务；没有 23:00 时不误排补发', async () => {
  clock('22:59:59'); const a = fixture(); a.config.summaryEnabled = false; a.service.schedule(); mock.timers.tick(1801000); await flush(); assert.equal(a.work.length, 0); a.service.stop()
  const b = fixture(); b.config.summaryTimes = ['22:00']; b.service.schedule(); await b.service.runSlot('23:30'); assert.equal(b.work.length, 0); b.service.stop()
})
await test('午夜后不执行上一晚的检查或补发', async () => {
  const e = fixture(); mock.timers.setTime(new Date('2026-10-08T00:05:00+08:00').getTime()); await e.service.runSlot('23:30', DAY); assert.equal(e.work.length, 0)
})
await test('旧配置的单数字小时仍正常排期，非法时间不会造成立即回调循环', async () => {
  clock('08:59:59'); const e = fixture(); e.config.summaryTimes = ['9:00', '99:99']; e.service.schedule()
  mock.timers.tick(1000); await flush(); assert.equal(e.work.length, 2); e.service.stop()
})

await test('完整总结流程：先存真实回执，23:30 不再次调用模型', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'summary-schedule-'))
  try {
    let calls = 0, sent = 0
    const logs = []
    const auditLogger = { info: message => logs.push(message), warn: message => logs.push(message), error: message => logs.push(message) }
    const start = new Date(`${DAY}T00:00:00+08:00`).getTime() / 1000
    const messages = [{ message_id: 1, message_seq: 1, time: start - 60, user_id: 123, message: text('昨日') },
      { message_id: 2, message_seq: 2, time: start + 72000, user_id: 123, sender: { nickname: '测试群友' }, message: text('今天的测试消息') }]
    const config = { summaryEnabled: true, summaryFallbackEnabled: true, summaryTimes: ['23:00'], summaryGroups: [101], whitelistGroups: new Set(), dataDir: dir, summaryMaxMessages: 600, summaryMaxBlocks: 20, summarySendMode: 'forward', summaryUserRows: 20, botName: '测试机器人' }
    const onebot = { selfId: '999', async refreshStatus() { return { connected: true, online: true } }, async getGroupMsgHistory() { return { messages } },
      async sendGroupForward() { sent++; return { message_id: 900 } }, async sendGroup() { throw Error('不应该逐条发送') } }
    const summary = createDailySummary({ config, logger: auditLogger, onebot, llm: { async chat() { calls++; return '💬 热门话题\n1. 测试话题\n   参与者: 测试群友\n   测试内容\n\n🏆 群友称号\n• 测试群友 - 测试称号\n  根据真实消息。\n\n💬 群圣经\n1. "今天的测试消息" —— 测试群友\n  真实点评。' } } })
    const run = summary.checkScheduled('23:00'); await flush(); mock.timers.tick(700); await flush(); await run
    assert.equal(sent, 1, logs.join('\n')); assert.equal(calls, 1)
    clock('23:30:00'); await summary.checkScheduled('23:30'); assert.equal(sent, 1); assert.equal(calls, 1); summary.stop()
  } finally { removeTemp(dir) }
})
console.log(`${passed} cases passed`)
