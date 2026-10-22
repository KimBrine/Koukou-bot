// 离线：踢人前置条件（纯函数，不发消息、不联网）
import assert from 'node:assert/strict'
import { canKickNow, canRunIdCheck, checkName, ID_CHECK_KICK_WINDOW_MS } from '../src/idCheck.js'

const now = 1_700_000_000_000
const bad = [{ userId: '1001', name: '王五', reason: '名字前面没有房间号' }]
const record = { group_id: 12345, at: now - 1000, bad, kicked: false }
const base = { groupId: 12345, userId: '1395168850', now, isBotAdmin: true, operators: ['1395168850'], record }

let pass = 0
const check = (name, ok) => {
  assert.ok(ok, name)
  pass++
  console.log('PASS', name)
}

check('授权名单为空时拒绝踢人（fail-closed）', canKickNow({ ...base, operators: [] }).ok === false)
check('名单为空时说明禁用原因', /未配置/.test(canKickNow({ ...base, operators: [] }).reason))
check('名单里没有这个人时拒绝', canKickNow({ ...base, userId: '1001' }).ok === false)
check('名单匹配且条件齐全才允许', canKickNow(base).ok === true)
check('名单带空格也能匹配', canKickNow({ ...base, operators: [' 1395168850 '] }).ok === true)
check('机器人不是管理员时拒绝', canKickNow({ ...base, isBotAdmin: false }).ok === false)
check('没有核对记录时拒绝', canKickNow({ ...base, record: null }).ok === false)
check('核对属于别的群时拒绝', canKickNow({ ...base, record: { ...record, group_id: 999 } }).ok === false)
check('核对过期后拒绝', canKickNow({ ...base, record: { ...record, at: now - ID_CHECK_KICK_WINDOW_MS - 1 } }).ok === false)
check('同一份核对只能踢一次', canKickNow({ ...base, record: { ...record, kicked: true } }).ok === false)
check('核对里没有不合格的人时拒绝', canKickNow({ ...base, record: { ...record, bad: [] } }).ok === false)
check('允许时带回要踢的名单', canKickNow(base).list?.[0]?.userId === '1001')
check('/id_check 仍保持开放默认', canRunIdCheck('1001', []) === true && canRunIdCheck('1001', ['1395168850']) === false)
check('房间号校验：604 通过 / 502 不通过', checkName('604方铁').ok === true && checkName('502王五').ok === false)
console.log(`id-check kick checks passed: ${pass}`)
