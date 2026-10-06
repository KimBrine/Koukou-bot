/**
 * /id_check 群名片核对单元测试。
 *   node scripts/test-id-check.mjs
 * 不联网、不发消息。
 */
const {
  ROOM_RE,
  displayName,
  checkName,
  checkMembers,
  buildReminderMessages,
  summarize,
  isLikelyBot,
  BOT_NAME_RE,
  ID_CHECK_CMD_RE,
  ID_CHECK_KICK_CMD_RE,
  canRunIdCheck,
  canKickNow,
  toHalfWidthDigits,
} = await import('../src/idCheck.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${extra ? `　${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? `　${extra}` : ''}`)
  }
}

console.log('\n=== 1. 合格的名字（6~10 层房间号）===')
const good = [
  ['602 方铁', '602'],
  ['903 李扣扣', '903'],
  ['604', '604'],
  ['1009', '1009'],
  ['1012 谁', '1012'],
  ['605方铁', '605'], // 没空格也认，避免误伤
  ['  804 示例机器人  ', '804'], // 前后空格被 trim
  ['1001 小明', '1001'],
  ['699 名字', '699'],
  ['1000', '1000'],
]
for (const [name, room] of good) {
  const r = checkName(name)
  ok(`${JSON.stringify(name)} 合格`, r.ok && r.room === room, `→ ok=${r.ok} room=${r.room ?? '-'}`)
}

console.log('\n=== 1b. 房号和名字之间不需要空格（用户明确要求）===')
const noSpace = [
  ['604方铁', '604'],
  ['906李扣扣', '906'],
  ['1009谁', '1009'],
  ['1012', '1012'],
  ['605方铁', '605'],
  ['914QWQ', '914'],
  ['817匹诺曹', '817'],
  ['1015zzm', '1015'],
  ['908余金纹', '908'],
  ['604Koukou.（机器人）', '604'],
  ['1001小明', '1001'],
]
for (const [name, room] of noSpace) {
  const r = checkName(name)
  ok(`无空格 ${JSON.stringify(name)} 合格`, r.ok && r.room === room, `→ ok=${r.ok} room=${r.room ?? '-'}`)
}

console.log('\n=== 1c. 各种分隔符和空白都认 ===')
const separators = [
  ['604\u3000方铁', '604', '全角空格 U+3000'],
  ['604\t方铁', '604', '制表符'],
  ['604   方铁', '604', '多个空格'],
  ['604-方铁', '604', '连字符'],
  ['604_方铁', '604', '下划线'],
  ['604·方铁', '604', '间隔号'],
  ['604.方铁', '604', '英文句点'],
  ['604。方铁', '604', '中文句号'],
  ['604|方铁', '604', '竖线'],
  ['604🍥方铁', '604', 'emoji'],
  ['604（小号）', '604', '括号备注'],
]
for (const [name, room, label] of separators) {
  const r = checkName(name)
  ok(`${label} ${JSON.stringify(name)} 合格`, r.ok && r.room === room, `→ ok=${r.ok} room=${r.room ?? '-'}`)
}

console.log('\n=== 1d. 全角数字也认（手机中文输入法常打出）===')
const fullWidth = [
  ['６０４方铁', '604'],
  ['６０４ 方铁', '604'],
  ['１００９', '1009'],
  ['９１３郑锦曦', '913'],
  ['６０４', '604'],
]
for (const [name, room] of fullWidth) {
  const r = checkName(name)
  ok(`全角 ${JSON.stringify(name)} 合格`, r.ok && r.room === room, `→ ok=${r.ok} room=${r.room ?? '-'}`)
}
ok('全角五楼 ５０２ 仍判为楼层 5', checkName('５０２王五').reason === '楼层 5 不在 6~10 层范围内', `→ ${checkName('５０２王五').reason}`)
ok('toHalfWidthDigits 只转数字', toHalfWidthDigits('６０４方铁ＡＢ') === '604方铁ＡＢ', `→ ${toHalfWidthDigits('６０４方铁ＡＢ')}`)
ok('toHalfWidthDigits 对 null 不崩', toHalfWidthDigits(null) === '')

console.log('\n=== 2. 楼层不在 6~10 范围 ===')
const floorBad = [
  ['502 王五', 5],
  ['401 赵六', 4],
  ['1102 赵六', 11],
  ['1203 x', 12],
  ['1900 y', 19],
]
for (const [name, floor] of floorBad) {
  const r = checkName(name)
  ok(`${JSON.stringify(name)} 判为楼层 ${floor}`, !r.ok && r.reason.includes(`楼层 ${floor} `), `→ ${r.reason}`)
}

console.log('\n=== 3. 格式不对 / 没有房间号 ===')
const malformed = [
  ['6045 名字', '房间号格式不对'],
  ['60451', '房间号格式不对'],
  ['10楼 方铁', '房间号格式不对'],
  ['17', '房间号格式不对'], // 1~2 位数字楼层判不准，不说错楼层
  ['10号CPY', '房间号格式不对'],
  ['1.1', '房间号格式不对'],
]
for (const [name, expect] of malformed) {
  const r = checkName(name)
  ok(`${JSON.stringify(name)} → ${expect}`, !r.ok && r.reason.includes(expect), `→ ${r.reason}`)
}

const noRoom = ['Absinth', '方铁', '东d702李佳轩', 'Q群管家', '楼上的猫']
for (const name of noRoom) {
  const r = checkName(name)
  ok(`${JSON.stringify(name)} → 名字前面没有房间号`, !r.ok && r.reason === '名字前面没有房间号', `→ ${r.reason}`)
}

console.log('\n=== 4. 空名字 ===')
for (const empty of ['', '   ', null, undefined]) {
  const r = checkName(empty)
  ok(`${JSON.stringify(empty)} → 没有群名片`, !r.ok && r.reason === '没有群名片', `→ ${r.reason}`)
}

console.log('\n=== 5. ROOM_RE 前缀匹配（名字里带数字不能被误判为房间号）===')
ok('ROOM_RE 不匹配 "602" 之外的杂串', ROOM_RE.exec('x602') === null)
ok('ROOM_RE 对 "0602" 匹配到 "60"？→ 不匹配', ROOM_RE.exec('0602') === null)
ok('"665544" 只吃掉前 3 位就会撞 (?!\\d) → 整体不匹配', ROOM_RE.exec('665544') === null)

console.log('\n=== 6. displayName 取名片优先、回落昵称 ===')
ok('有群名片用群名片', displayName({ card: '602 方铁', nickname: '真名' }) === '602 方铁')
ok('名片为空回落昵称', displayName({ card: '', nickname: '方铁' }) === '方铁')
ok('名片是纯空格也回落昵称', displayName({ card: '   ', nickname: '方铁' }) === '方铁')
ok('两者都空得到空串', displayName({}) === '')
ok('null 不崩', displayName(null) === '')

console.log('\n=== 7. checkMembers 整群核对 ===')
const members = [
  { user_id: 1, card: '602 方铁', nickname: 'a', role: 'owner' },
  { user_id: 2, card: '', nickname: 'Absinth' },
  { user_id: 3, card: '1102 赵六', nickname: 'c' },
  { user_id: 200000014, card: '机器人自己', nickname: 'bot' }, // 应被 selfId 跳过
  { user_id: 5, card: '1009 谁', nickname: 'e' },
  { user_id: 6, card: '502 王五', nickname: 'f' },
  { user_id: 999, card: '随便', nickname: 'g' }, // 应被 skip 跳过
  { user_id: '', card: 'x' }, // 无 user_id，跳过
]
const res = checkMembers(members, { selfId: '200000014', skip: ['999'] })
ok('total 只数真正参与核对的人', res.total === 5, `→ ${res.total}`)
ok('合格 2 人', res.ok.length === 2, `→ ${res.ok.map((o) => o.name).join(' / ')}`)
ok('不合格 3 人', res.bad.length === 3, `→ ${res.bad.map((b) => b.name).join(' / ')}`)
ok('机器人自己被跳过', ![...res.ok, ...res.bad].some((x) => x.userId === '200000014'))
ok('skip 名单被跳过', ![...res.ok, ...res.bad].some((x) => x.userId === '999'))
ok('bad 带 role 字段', res.bad.every((b) => typeof b.role === 'string'))
ok('成员列表非数组时不崩', checkMembers(null).total === 0)
ok('成员列表非数组时 bad 为空数组', Array.isArray(checkMembers(undefined).bad))
ok('userId 统一成字符串', res.ok.every((o) => typeof o.userId === 'string'))

console.log('\n=== 8. buildReminderMessages 分段 ===')
const bad = Array.from({ length: 23 }, (_, i) => ({ userId: String(1000 + i), name: `n${i}` }))
const one = buildReminderMessages(bad)
ok('默认不拆分：23 人 → 1 条消息', one.length === 1, `→ ${one.length}`)
ok('那一条里有 23 个 at', one[0].filter((s) => s.type === 'at').length === 23)
ok('那一条结尾带提醒语', one[0].at(-1).data.text.includes('改名'))
ok('perMessage=0 也不拆分', buildReminderMessages(bad, { perMessage: 0 }).length === 1)
ok('显式 perMessage=10 才拆成 3 条', buildReminderMessages(bad, { perMessage: 10 }).length === 3)

const msgs = buildReminderMessages(bad, { perMessage: 10 })
ok('第 1 条 10 个 at', msgs[0].filter((s) => s.type === 'at').length === 10)
ok('第 3 条 3 个 at', msgs[2].filter((s) => s.type === 'at').length === 3)
ok('每个人后面跟一个换行', msgs[0].filter((s) => s.type === 'text' && s.data.text === '\n').length === 10)
ok('只有最后一条带提醒语', !msgs[0].at(-1).data.text.includes('改名') && msgs[2].at(-1).data.text.includes('改名'))
ok('at 段的 qq 是字符串', msgs[0][0].data.qq === '1000')
ok('空名单 → 没有消息（不发空提醒）', buildReminderMessages([]).length === 0)
ok('perMessage=1 → 每人一条', buildReminderMessages(bad.slice(0, 3), { perMessage: 1 }).length === 3)
ok(
  '提醒语可自定义',
  buildReminderMessages(bad.slice(0, 1), { reminder: '改一下哦' }).at(-1).at(-1).data.text === '改一下哦'
)
ok('真实规模（35 人）也是一条发完', buildReminderMessages(Array.from({ length: 35 }, (_, i) => ({ userId: String(i) }))).length === 1)

console.log('\n=== 9. summarize ===')
ok('全部合格', summarize([]) === '全部合格')
const s = summarize([
  { userId: '1', name: 'Absinth', reason: '名字前面没有房间号' },
  { userId: '2', name: '', reason: '没有群名片' },
])
ok('带名字和原因', s.includes('Absinth(1)') && s.includes('(空)(2)'), `→ ${s}`)
const many = summarize(
  Array.from({ length: 20 }, (_, i) => ({ userId: String(i), name: `n${i}`, reason: 'r' })),
  { max: 3 }
)
ok('超长时截断并报总数', many.includes('共 20 人'), `→ ${many.slice(-12)}`)

console.log('\n=== 10. isLikelyBot：可靠标志 is_robot ===')
ok('is_robot=true 判为机器人', isLikelyBot({ nickname: '随便', is_robot: true }) === true)
ok('is_robot=false 且名字正常判为真人', isLikelyBot({ nickname: 'Absinth', is_robot: false }) === false)
ok('没有 is_robot 字段不崩', isLikelyBot({ nickname: 'Absinth' }) === false)
ok('null 不崩', isLikelyBot(null) === false)
ok('is_robot=true 时即使名字合规也判为机器人', isLikelyBot({ card: '604 小明', is_robot: true }) === true)

console.log('\n=== 11. isLikelyBot：服务账号名字特征 ===')
const serviceBots = ['Q群管家', 'QQ群管家', '群助手', '群机器人', '【店员】店员猫', '【客服】小美', '【官方】账号']
for (const n of serviceBots) ok(`${JSON.stringify(n)} 判为服务账号`, isLikelyBot({ nickname: n, is_robot: false }) === true)

console.log('\n=== 12. 名字特征不能误伤真人（关键）===')
const humans = [
  'Absinth',
  '604 方铁',
  '【摸鱼】小明', // 方括号但不是服务类标签
  '小助手是我', // 不是以"小助手"结尾
  '管家婆', // 只有"管家"没有"群管家"
  '机器人爱好者',
  '静玉',
  '东d702李佳轩',
]
for (const n of humans) ok(`${JSON.stringify(n)} 不误判`, isLikelyBot({ nickname: n, is_robot: false }) === false)

// 设计取舍：只要名字以服务类标签开头就跳过（哪怕后面跟的是句玩笑话）。
// 宁可漏提醒一个真人（他自己会看到别人被 @ 而发现格式不对），也不要 @ 服务号。
ok('以服务标签开头一律跳过（有意取舍）', isLikelyBot({ nickname: '【店员】是我的梦想', is_robot: false }) === true)

console.log('\n=== 13. checkMembers 跳过逻辑 ===')
const mixed = [
  { user_id: 1, card: '604 方铁' },
  { user_id: 2, nickname: 'Absinth' },
  { user_id: 3, nickname: 'Q群管家', is_robot: true }, // QQ 机器人
  { user_id: 4, nickname: '【店员】店员猫', is_robot: false }, // 名字特征
  { user_id: 200000014, card: '604 Koukou.（机器人）' }, // 机器人自己
  { user_id: 6, nickname: '静玉' },
]
const m1 = checkMembers(mixed, { selfId: '200000014' })
ok('total 只数真正核对的人', m1.total === 3, `→ ${m1.total}`)
ok('不合格 2 人（Absinth / 静玉）', m1.bad.length === 2, `→ ${m1.bad.map((b) => b.name).join(' / ')}`)
ok('skipped 记了 3 个人', m1.skipped.length === 3, `→ ${m1.skipped.map((s) => `${s.name}:${s.why}`).join('、')}`)
ok('机器人自己标注为「机器人自己」', m1.skipped.find((s) => s.userId === '200000014')?.why === '机器人自己')
ok('is_robot 标为「QQ 机器人账号」', m1.skipped.find((s) => s.userId === '3')?.why === 'QQ 机器人账号')
ok('名字特征标为「名字像服务账号」', m1.skipped.find((s) => s.userId === '4')?.why === '名字像服务账号')
ok('被跳过的人不出现在 bad 里', !m1.bad.some((b) => ['3', '4', '200000014'].includes(b.userId)))

const m2 = checkMembers(mixed, { selfId: '200000014', skipBots: false })
ok('skipBots=false 时不按名字/标志跳（只剩自己）', m2.skipped.length === 1 && m2.bad.length === 4, `→ bad=${m2.bad.length}`)

const m3 = checkMembers(mixed, { selfId: '200000014', skip: ['2'] })
ok('ID_CHECK_SKIP 名单生效', m3.bad.length === 1 && m3.skipped.some((s) => s.userId === '2'))
ok('跳过原因是 ID_CHECK_SKIP 指定跳过', m3.skipped.find((s) => s.userId === '2')?.why === 'ID_CHECK_SKIP 指定跳过')
ok('自定义 botNameRe 可覆盖默认', checkMembers([{ user_id: 9, nickname: '张三' }], { botNameRe: /张三/ }).total === 0)
ok('skipped 默认是数组（老调用方不崩）', Array.isArray(checkMembers([]).skipped))
ok('BOT_NAME_RE 是 RegExp', BOT_NAME_RE instanceof RegExp)

console.log('\n=== 14. ID_CHECK_CMD_RE：用户可能怎么打这个指令 ===')
const shouldTrigger = [
  '/id_check',
  '／id_check', // 中文输入法下的全角斜杠
  '/idcheck',
  '/ID_CHECK',
  '/id check',
  '/id-check',
  'id_check', // 忘了打斜杠
  ' /id_check ', // 前后有空格（@ 段被剥掉后常留一个空格）
  '/id_check。',
  '/id_check!',
  '/查名片',
  '/名片核对',
  '/名字核对',
  '名字核对',
]
for (const t of shouldTrigger) ok(`触发: ${JSON.stringify(t)}`, ID_CHECK_CMD_RE.test(t.trim()) === true)

const shouldNot = [
  '/id_check 3', // 带参数（这个指令不吃参数）
  '帮我 /id_check 一下', // 夹在句子里
  '/查名片吧',
  '今天总结',
  '/群总结',
  'id_check是什么',
  '',
  '   ',
]
for (const t of shouldNot) ok(`不触发: ${JSON.stringify(t)}`, ID_CHECK_CMD_RE.test(t.trim()) === false)

console.log('\n=== 15. canRunIdCheck：只有授权 QQ 能触发 ===')
const ops = ['200000007', '200000006']
ok('授权名单里的 QQ 放行', canRunIdCheck('200000007', ops) === true)
ok('第二个授权 QQ 也放行', canRunIdCheck('200000006', ops) === true)
ok('数字类型 QQ 也认', canRunIdCheck(200000007, ops) === true)
ok('没授权的群员被拦', canRunIdCheck('200000013', ops) === false)
ok('机器人自己被拦（不该自己触发自己）', canRunIdCheck('200000014', ops) === false)
ok('拿不到 QQ 时拦下（保守）', canRunIdCheck(undefined, ops) === false)
ok('拿不到 QQ（null）时拦下', canRunIdCheck(null, ops) === false)
ok('空字符串 QQ 被拦', canRunIdCheck('', ops) === false)
ok('号码前缀相同但不相等 → 拦（不做前缀匹配）', canRunIdCheck('200000020', ops) === false)
ok('前后带空格的 QQ 也认', canRunIdCheck(' 200000007 ', ops) === true)
ok('名单项带空格也能匹配上', canRunIdCheck('200000007', [' 200000007 ', '']) === true)
ok('名单为空 → 不限制（谁都能触发）', canRunIdCheck('999', []) === true)
ok('名单不是数组 → 不限制', canRunIdCheck('999', null) === true)

console.log('\n=== 16. 配置链路：.env → loadConfig → 授权判定 ===')
process.env.ID_CHECK_OPERATORS = '200000007, 200000006 ,'
const { loadConfig } = await import('../src/config.js')
const cfg = loadConfig()
ok('解析出 2 个授权 QQ', cfg.idCheckOperators.length === 2, `→ ${JSON.stringify(cfg.idCheckOperators)}`)
ok('空格被清掉', cfg.idCheckOperators.includes('200000006'))
ok('空项被丢掉', !cfg.idCheckOperators.includes(''))
ok('配置里的人能触发', canRunIdCheck('200000007', cfg.idCheckOperators) === true)
ok('配置外的人被拦', canRunIdCheck('1234567', cfg.idCheckOperators) === false)
ok(
  'ID_CHECK_PER_MESSAGE 解析为非负整数（0 = 不拆分）',
  Number.isInteger(cfg.idCheckPerMessage) && cfg.idCheckPerMessage >= 0,
  `→ ${cfg.idCheckPerMessage}`
)
ok('默认不拆分（一次性 @ 完）', cfg.idCheckPerMessage === 0, `→ ${cfg.idCheckPerMessage}`)
ok('ID_CHECK_SKIP_BOTS 解析为布尔', cfg.idCheckSkipBots === true, `→ ${cfg.idCheckSkipBots}`)
ok('ID_CHECK_SKIP 为空时是空数组', Array.isArray(cfg.idCheckSkip))

console.log('\n=== 17. ID_CHECK_KICK_CMD_RE：触发写法 ===')
const kickShould = ['/id_check_kick', '／id_check_kick', '/idcheckkick', '/id_check_kick。', '/id check kick', '/核对踢人', '核对踢人', '/查名片踢人']
for (const t of kickShould) ok(`踢人指令触发: ${JSON.stringify(t)}`, ID_CHECK_KICK_CMD_RE.test(t.trim()) === true)
const kickShouldNot = ['/id_check_kick 一下', '/id_check', '/群总结', '踢人', '', '   ']
for (const t of kickShouldNot) ok(`踢人指令不触发: ${JSON.stringify(t)}`, ID_CHECK_KICK_CMD_RE.test(t.trim()) === false)

console.log('\n=== 18. 两个指令必须互斥（一条消息写两个 = 两个都不生效）===')
ok('"/id_check" 只触发核对', ID_CHECK_CMD_RE.test('/id_check') === true && ID_CHECK_KICK_CMD_RE.test('/id_check') === false)
ok('"/id_check_kick" 只触发踢人', ID_CHECK_KICK_CMD_RE.test('/id_check_kick') === true && ID_CHECK_CMD_RE.test('/id_check_kick') === false)
for (const both of ['/id_check /id_check_kick', '/id_check_kick /id_check', '/id_check/id_check_kick', '/id_check，/id_check_kick']) {
  ok(
    `${JSON.stringify(both)} 两个都不触发`,
    ID_CHECK_CMD_RE.test(both) === false && ID_CHECK_KICK_CMD_RE.test(both) === false
  )
}

console.log('\n=== 19. canKickNow：五条前置条件逐条验 ===')
const OPS = ['200000007', '200000006']
const NOW = 1_700_000_000_000
const mkRec = (over = {}) => ({
  group_id: 200000002,
  at: NOW - 60_000, // 1 分钟前
  kicked: false,
  bad: [{ userId: '1', name: 'Absinth' }, { userId: '2', name: '静玉' }],
  ...over,
})
const base = { groupId: 200000002, userId: '200000007', operators: OPS, now: NOW, isBotAdmin: true }
const K = (o = {}) => canKickNow({ ...base, record: mkRec(), ...o })

ok('全部满足 → 放行', K().ok === true, `→ ${K().reason}`)
ok('放行时带回名单', K().list.length === 2)
ok('第二个授权 QQ 也放行', K({ userId: '200000006' }).ok === true)

ok('条件1：机器人不是管理员 → 拦', K({ isBotAdmin: false }).ok === false, `→ ${K({ isBotAdmin: false }).reason}`)
ok('条件2：没有核对记录 → 拦', K({ record: null }).ok === false, `→ ${K({ record: null }).reason}`)
ok('条件2：6 分钟前跑的（超 5 分钟）→ 拦', K({ record: mkRec({ at: NOW - 6 * 60 * 1000 }) }).ok === false)
ok('条件2：刚好 5 分钟 → 放行（边界含端点）', K({ record: mkRec({ at: NOW - 5 * 60 * 1000 }) }).ok === true)
ok('条件2：5 分钟零 1 毫秒 → 拦', K({ record: mkRec({ at: NOW - 5 * 60 * 1000 - 1 }) }).ok === false)
ok('条件2：时间戳是未来值 → 拦', K({ record: mkRec({ at: NOW + 60_000 }) }).ok === false)
ok('条件2：自定义窗口（1 分钟）也能拦', canKickNow({ ...base, record: mkRec({ at: NOW - 90_000 }), windowMs: 60_000 }).ok === false)
ok('条件3：已经踢过一次 → 拦', K({ record: mkRec({ kicked: true }) }).ok === false, `→ ${K({ record: mkRec({ kicked: true }) }).reason}`)
ok('条件4：没授权的群员 → 拦', K({ userId: '200000013' }).ok === false, `→ ${K({ userId: '200000013' }).reason}`)
ok('条件4：授权名单为空 → 不限制（与核对指令同规则）', canKickNow({ ...base, userId: '999', operators: [], record: mkRec() }).ok === true)
ok('条件5：上次核对没人不合格 → 拦', K({ record: mkRec({ bad: [] }) }).ok === false, `→ ${K({ record: mkRec({ bad: [] }) }).reason}`)
ok('别的群跑的核对 → 拦', K({ record: mkRec({ group_id: 200000017 }) }).ok === false)
ok('群号字符串/数字混用也认', K({ groupId: '200000002', record: mkRec({ group_id: 200000002 }) }).ok === true)
ok('bad 字段不是数组 → 拦（不崩）', K({ record: mkRec({ bad: null }) }).ok === false)
ok('record 缺 at → 拦（不崩）', K({ record: { group_id: 200000002, bad: [{ userId: '1' }] } }).ok === false)

console.log('\n=== 20. 拦下时不能带名单（防止误用）===')
const denied = canKickNow({ ...base, isBotAdmin: false, record: mkRec() })
ok('被拦时没有 list 字段', denied.list === undefined)
ok('被拦时 reason 非空', typeof denied.reason === 'string' && denied.reason.length > 0)
ok('每种拒绝都有各自的原因', new Set([
  K({ isBotAdmin: false }).reason,
  K({ record: null }).reason,
  K({ record: mkRec({ kicked: true }) }).reason,
  K({ userId: '999' }).reason,
  K({ record: mkRec({ bad: [] }) }).reason,
]).size === 5)

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
