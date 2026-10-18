import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeAdmins, hasAdmins, isBotAdmin, adminHint } from '../src/permissions.js'
import { createCustomCommands, renderReply } from '../src/customCommands.js'
import { ADMIN_HELP_CMD_RE } from '../src/bot.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-admin-cmd-'))
const logger = { info() {}, warn() {}, debug() {}, error() {} }
try {
  // ============ 管理员判定 ============
  assert.deepEqual(normalizeAdmins(' 1, 2 ,'), ['1', '2'])
  assert.deepEqual(normalizeAdmins(undefined), [])
  assert.equal(hasAdmins([]), false)
  assert.equal(hasAdmins(['1']), true)
  assert.equal(isBotAdmin(123, []), true, '留空 = 不限制')
  assert.equal(isBotAdmin('1', ['1']), true)
  assert.equal(isBotAdmin(999, ['1']), false)
  assert.equal(isBotAdmin(' 1 ', ['1']), true, '两端空格不影响')
  assert.match(adminHint([]), /未配置管理员/)
  assert.match(adminHint(['1']), /1/)

  // ============ 自定义指令 ============
  const file = path.join(root, 'custom-commands.json')
  const cc = createCustomCommands({ file, logger })
  assert.throws(() => cc.upsert({ trigger: '', reply: 'x' }), /触发词/)
  assert.throws(() => cc.upsert({ trigger: 'x', reply: '  ' }), /回复内容/)

  const a = cc.upsert({ name: '打招呼', trigger: '早安', match: 'exact', reply: '早上好 {name}' })
  const b = cc.upsert({ name: '签到', trigger: '/签到', match: 'prefix', reply: '签到成功', cooldownSec: 60 })
  assert.equal(cc.all().length, 2)
  assert.equal(cc.match('早安', { name: '小明' }).name, '打招呼')
  assert.equal(cc.match('早安啊', {}), null, '完全匹配不误伤长句')
  assert.equal(cc.match('/签到 今天', {}).name, '签到')
  assert.equal(cc.match('我要/签到', {}), null)

  // 范围
  cc.upsert({ name: '群专用', trigger: '开黑', match: 'exact', reply: '来', scope: 'group', groups: [831838803] })
  assert.equal(cc.match('开黑', { isPrivate: false, groupId: 831838803 }).name, '群专用')
  assert.equal(cc.match('开黑', { isPrivate: false, groupId: 999 }), null)
  assert.equal(cc.match('开黑', { isPrivate: true, userId: 1 }), null)

  // 冷却
  assert.equal(cc.match('/签到', { isPrivate: false, groupId: 111 }).name, '签到')
  assert.equal(cc.match('/签到', { isPrivate: false, groupId: 111 }), null, '冷却中')
  assert.equal(cc.match('/签到', { isPrivate: false, groupId: 222 }).name, '签到', '换会话不受影响')

  // 停用
  cc.upsert({ ...a, enabled: false })
  assert.equal(cc.match('早安', {}), null)

  // 删除
  assert.equal(cc.remove(b.id), true)
  assert.equal(cc.remove(b.id), false)

  // 定时推送
  const nowD = new Date()
  const hh = String(nowD.getHours()).padStart(2, '0')
  const mm = String(nowD.getMinutes()).padStart(2, '0')
  cc.upsert({ name: '早报', trigger: '不触发', reply: '早上好 {date}', scheduleEnabled: true,
    scheduleTimes: hh + ':' + mm, scheduleGroups: [111, 222] })
  const due1 = cc.due(nowD.getTime())
  assert.equal(due1.length, 2, '两个群各一次')
  assert.equal(cc.due(nowD.getTime()).length, 0, '同分钟不重复')
  const other = new Date(nowD.getTime()); other.setHours((nowD.getHours() + 1) % 24)
  assert.equal(cc.due(other.getTime()).length, 0)

  // 变量
  const fixed = new Date('2026-10-18T09:05:00')
  assert.equal(renderReply('你好{name}', { name: '小明' }), '你好小明')
  assert.equal(renderReply('{qq}', { userId: 10001 }), '10001')
  assert.equal(renderReply('{date}', { now: fixed }), '2026-10-18')
  assert.equal(renderReply('{unknown}', {}), '{unknown}', '未知变量原样保留')
  assert.equal(renderReply('{name}', {}), '你')

  // ============ /help 识别 ============
  assert.ok(ADMIN_HELP_CMD_RE.test('/help'))
  assert.ok(ADMIN_HELP_CMD_RE.test('/帮助'))
  assert.ok(ADMIN_HELP_CMD_RE.test('／指令'))
  assert.ok(!ADMIN_HELP_CMD_RE.test('help'), '没有斜杠不算')
  assert.ok(!ADMIN_HELP_CMD_RE.test('你能帮我吗'))

  console.log('管理员 / 自定义指令 / help 检查通过：约 40 组断言。')
} finally {
  rmSync(root, { recursive: true, force: true })
}
