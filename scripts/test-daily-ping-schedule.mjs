import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { createDailyPing, dailyPingTarget } from '../src/dailyPing.js'

const config = {
  dailyPingEnabled: true, dailyPingTime: '00:00', dailyPingGroup: '200000019',
  dailyPingTarget: '200000015', dailyPingText: '/今日猪猪',
  dailyPingChainEnabled: true, dailyPingChainText: '/我的猪圈', dailyPingChainWindowMs: 90000,
}
const logger = { info() {}, warn() {}, error() {}, debug() {} }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function env(now, overrides = {}) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(now).getTime() })
  const sent = []
  const onebot = { selfId: '200000010', async sendGroup(group, message) {
    sent.push({ at: Date.now(), group, message }); return { message_id: sent.length }
  } }
  const dp = createDailyPing({ config: { ...config, ...overrides }, onebot, logger })
  return { dp, sent, close() { dp.stop(); mock.timers.reset() } }
}
async function advance(ms) { mock.timers.tick(ms); await flush() }

// The two-second QQ clock difference from the real incident must not cause a previous-day draw.
{
  const e = env('2026-10-03T23:59:58+08:00')
  e.dp.schedule(); e.dp.schedule()
  await advance(2000)
  assert.equal(e.sent.length, 0, '00:00 must wait through the safety buffer')
  await advance(9999)
  assert.equal(e.sent.length, 0)
  await advance(1)
  assert.equal(e.sent.length, 1)
  assert.equal(e.sent[0].at - 2000, new Date('2026-10-04T00:00:08+08:00').getTime())
  await advance(60000)
  assert.equal(e.sent.length, 1, 'must not catch up a second time')
  e.close()
}
// Restarting inside the safety buffer cannot bypass it via startup catch-up.
{
  const e = env('2026-10-04T00:00:03+08:00')
  e.dp.schedule()
  await advance(0)
  assert.equal(e.sent.length, 0)
  await advance(7000)
  assert.equal(e.sent.length, 1)
  e.close()
}
// Catch-up after the buffer still works.
{
  const e = env('2026-10-04T00:02:00+08:00')
  e.dp.schedule(); await advance(0)
  assert.equal(e.sent.length, 1)
  e.close()
}
// A Windows clock correction backwards cannot let an already-armed timer send early.
{
  const e = env('2026-10-03T23:59:58+08:00')
  e.dp.schedule()
  mock.timers.setTime(new Date('2026-10-03T23:59:00+08:00').getTime())
  await advance(12000)
  assert.equal(e.sent.length, 0)
  await advance(58000)
  assert.equal(e.sent.length, 1)
  e.close()
}
// Subsequent days must remain scheduled once each; stop cancels the pending day.
{
  const e = env('2026-10-04T00:00:10+08:00')
  e.dp.schedule(); await advance(0)
  for (let i = 0; i < 1440; i++) await advance(60000)
  assert.equal(e.sent.length, 2)
  e.dp.stop()
  await advance(86400000)
  assert.equal(e.sent.length, 2)
  e.close()
}
// All non-midnight schedules keep their configured second-zero timing.
assert.equal(dailyPingTarget(12, 30, new Date('2026-10-04T02:00:00+08:00')).getSeconds(), 0)

// The target's replies to other users must never become this bot's draw result.
{
  const e = env('2026-10-04T00:00:10+08:00')
  await e.dp.sendNow('test')
  const response = (id, type = 'markdown') => ({ group_id: config.dailyPingGroup, user_id: config.dailyPingTarget,
    message: type === 'at' ? [{ type: 'at', data: { qq: id } }] : [
      { type: 'markdown', data: { content: `[@user](mqqapi://markdown/mention?at_type=1&at_tinyid=${id})` } },
    ],
  })
  const parsed = { text: '🎉 抓到一只新猪猪啦！ 【柠檬猪尾酒】' }
  await e.dp.noteMessage(response('200000007'), parsed)
  assert.equal(e.dp.state()[config.dailyPingGroup].pig, undefined)
  await e.dp.noteMessage(response('200000016', 'at'), parsed)
  assert.equal(e.dp.state()[config.dailyPingGroup].pig, undefined)
  assert.ok(e.dp.pendingChain())
  await e.dp.noteMessage(response('200000010'), parsed)
  assert.equal(e.dp.state()[config.dailyPingGroup].pig, '柠檬猪尾酒')
  await advance(4000)
  assert.equal(e.sent.length, 2, 'own success still triggers the pig pen follow-up')
  e.close()
}
console.log('Daily ping schedule checks passed: midnight buffer, restart, catch-up, clock correction, daily recurrence, stop, recipient correlation')
