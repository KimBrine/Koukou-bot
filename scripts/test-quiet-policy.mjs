import assert from 'node:assert/strict'
import { quietBlocked, quietTransport } from '../src/quietPolicy.js'

const config = { quietHours: '01:00-07:00' }
const at = (h, m = 0) => new Date(2026, 0, 1, h, m)
assert.equal(quietBlocked(config, null, 'g1', at(1)), true)
assert.equal(quietBlocked(config, null, 'g1', at(7)), false)
assert.equal(quietBlocked(config, { get: () => ({ quietHours: '' }) }, 'g1', at(2)), false)
assert.equal(quietBlocked(config, { get: () => ({ quietHours: '23:00-08:00' }) }, 'g1', at(0)), true)
assert.equal(quietBlocked({ ...config, quietHoursBlockAll: false }, null, 'p2', at(2)), false)

let asleep = false, sent = 0
const raw = { selfId: 3, async getGroupMemberInfo() { return this.selfId }, async deleteMessage() { sent++ } }
for (const method of ['sendGroup', 'sendPrivate', 'sendGroupForward', 'sendPrivateForward', 'setGroupBan', 'clearGroupBan', 'setGroupWholeBan', 'setGroupKick', 'pokeGroupMember', 'repeatGroupMessage', 'poke', 'api']) raw[method] = async function () { assert.equal(this, raw); sent++; return { message_id: 1 } }
const transport = quietTransport(raw, key => asleep && ['g1', 'p2'].includes(key))
await transport.sendGroup(1, '入睡前')
asleep = true
for (const [method, args] of [
  ['sendGroup', [1]], ['sendPrivate', [2]], ['sendGroupForward', [1]], ['sendPrivateForward', [2]],
  ['setGroupBan', [1]], ['clearGroupBan', [1]], ['setGroupWholeBan', [1]], ['setGroupKick', [1]],
  ['pokeGroupMember', [1]], ['repeatGroupMessage', [1]], ['poke', [{ groupId: 1, userId: 2 }]],
  ['poke', [{ userId: 2 }]], ['api', ['upload_group_file', { group_id: 1 }]],
  ['api', ['friend_poke', { user_id: 2 }]],
]) await assert.rejects(transport[method](...args), { code: 'QUIET_HOURS_BLOCKED' })
assert.equal(sent, 1)
assert.equal(await transport.getGroupMemberInfo(1, 2), 3)
// 共享原客户端供早晚安使用，不受互动视图的拦截影响。
await raw.sendGroup(1, '边界晚安')
await transport.sendGroup(4, '未设置寂静时段的其他会话')
asleep = false
await transport.sendPrivate(2, '醒来后的新请求')
assert.equal(sent, 4)
console.log('Quiet boundaries, per-chat overrides and outbound interaction guards passed; no network calls.')
