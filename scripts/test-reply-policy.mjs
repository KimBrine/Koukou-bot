/**
 * 回复策略单元测试：按群独立概率 + 白名单/安静时段/冷却/@ 的判定顺序。
 *   node scripts/test-reply-policy.mjs
 * 不联网、不发消息。
 */
process.env.PROACTIVE_RATE = '0.1'
process.env.PROACTIVE_RATE_PER_GROUP = '200000019:0.35,200000017:0.3,200000001:0.1,900000001:2,900000002:-1,垃圾数据'
process.env.WHITELIST_GROUPS = '200000019,200000017,200000001'
process.env.QUIET_HOURS = '01:00-07:00'

const { loadConfig } = await import('../src/config.js')
const { decideReply } = await import('../src/bot.js')

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

console.log('\n=== 1. PROACTIVE_RATE_PER_GROUP 解析 ===')
const config = loadConfig()
ok('独立配置的群取到独立值', config.proactiveRateFor(200000019) === 0.35, `→ ${config.proactiveRateFor(200000019)}`)
ok('第二个群也独立', config.proactiveRateFor(200000017) === 0.3, `→ ${config.proactiveRateFor(200000017)}`)
ok('盯人群保持 0.1', config.proactiveRateFor(200000001) === 0.1, `→ ${config.proactiveRateFor(200000001)}`)
ok('未列出的群回落到全局 PROACTIVE_RATE', config.proactiveRateFor(999999999) === 0.1, `→ ${config.proactiveRateFor(999999999)}`)
ok('概率被夹到 [0,1]（2 → 1）', config.proactiveRateFor(900000001) === 1, `→ ${config.proactiveRateFor(900000001)}`)
ok('负概率被夹到 0', config.proactiveRateFor(900000002) === 0, `→ ${config.proactiveRateFor(900000002)}`)
ok('垃圾数据被忽略（不崩、不产生 NaN 项）', ![...config.proactiveRatePerGroup.values()].some((v) => Number.isNaN(v)))
ok('字符串群号也能查到', config.proactiveRateFor('200000019') === 0.35, `→ ${config.proactiveRateFor('200000019')}`)

console.log('\n=== 2. decideReply 判定顺序 ===')
const mk = (over = {}) => ({
  whitelistGroups: new Set([200000019, 200000017, 200000001]),
  proactiveRate: 0.1,
  proactiveRatePerGroup: new Map(),
  proactiveRateFor(groupId) {
    return this.proactiveRatePerGroup.has(Number(groupId))
      ? this.proactiveRatePerGroup.get(Number(groupId))
      : this.proactiveRate
  },
  proactiveCooldownMs: 0,
  quietHours: '',
  ...over,
})

const t = (h, m) => new Date(2026, 8, 21, h, m, 0).getTime()
const always = mk({ proactiveRate: 1 })
const never = mk({ proactiveRate: 0 })

console.log('\n=== 1b. 静音群 MUTED_GROUPS（换号迁移：旧号在新号接管的群里彻底闭嘴）===')
// 背景：白名单只管"主动搭话"，管不住"群内被@必回"。迁移期间旧号虽然不在白名单里，
// 被 @ 时照样会说话，所以需要一道独立闸门让它彻底不出声。
const muted = (groups) => mk({ mutedGroups: new Set(groups) })
const D = (config, over = {}) =>
  decideReply({ isPrivate: false, atBot: true, groupId: 200000019, config, lastProactive: new Map(), ...over })

ok('静音群里被@也不回', D(muted([200000019])).reply === false)
ok('拒绝理由写明是静音', D(muted([200000019])).reason.includes('静音'), `→ ${D(muted([200000019])).reason}`)
ok('静音群里普通消息也不回', D(muted([200000019]), { atBot: false }).reply === false)
ok('不在静音名单的群不受影响', D(muted([200000019]), { groupId: 200000002 }).reply === true)
ok('群号传字符串也认', D(muted([200000019]), { groupId: '200000019' }).reply === false)
ok('私聊不受静音影响', D(muted([200000019]), { isPrivate: true, groupId: undefined }).reply === true)
ok('静音名单为空时一切照旧', D(muted([])).reply === true)
ok('没配 mutedGroups 也不崩', D(mk({ mutedGroups: undefined })).reply === true)
ok('静音优先于被@必回（两者同时命中时以静音为准）', D(muted([200000019]), { atBot: true }).reason.includes('静音'))

console.log('\n=== 1c. 安静时段彻底静音 QUIET_HOURS_BLOCK_ALL（默认开）===')
// 背景：真人睡着时不回任何消息。"凌晨被@就秒回"是很容易被看出的机器人特征。
// 不写 quietHoursBlockAll 就是默认开启，所以下面故意不传它。
const QUIET = '01:00-07:00'
const at = (h, m = 0) => new Date(2026, 8, 24, h, m, 0).getTime()
const qc = (over = {}) => mk({ quietHours: QUIET, ...over })
const qD = (over = {}, when = 3, call = {}) =>
  decideReply({
    isPrivate: false,
    atBot: true,
    groupId: 200000019,
    config: qc(over),
    lastProactive: new Map(),
    now: at(when),
    ...call,
  })

ok('凌晨被@也不回', qD().reply === false, `→ ${qD().reason}`)
ok('拒绝理由写明是安静时段', qD().reason.includes('安静时段'), `→ ${qD().reason}`)
ok(
  '凌晨私聊也不回',
  decideReply({ isPrivate: true, atBot: false, groupId: undefined, config: qc(), lastProactive: new Map(), now: at(3) }).reply === false,
)
ok('凌晨主动搭话也不回（概率给满也不回）', qD({ proactiveRate: 1 }).reply === false)
ok(
  '白天被@照常回',
  decideReply({ isPrivate: false, atBot: true, groupId: 200000019, config: qc(), lastProactive: new Map(), now: at(12) }).reply === true,
)
ok(
  '白天私聊照常回',
  decideReply({ isPrivate: true, atBot: false, groupId: undefined, config: qc(), lastProactive: new Map(), now: at(12) }).reply === true,
)
const atQuiet = (h, mi) =>
  decideReply({ isPrivate: true, atBot: false, groupId: undefined, config: qc(), lastProactive: new Map(), now: at(h, mi) }).reply === false
ok('边界：01:00 算安静，00:59 不算', atQuiet(1, 0) && !atQuiet(0, 59))
ok('边界：06:59 算安静，07:00 不算', atQuiet(6, 59) && !atQuiet(7, 0))
ok(
  'BLOCK_ALL=0 退回旧行为：凌晨被@仍回',
  qD({ quietHoursBlockAll: false }).reply === true,
)
ok(
  'BLOCK_ALL=0 凌晨私聊仍回',
  decideReply({ isPrivate: true, atBot: false, groupId: undefined, config: qc({ quietHoursBlockAll: false }), lastProactive: new Map(), now: at(3) }).reply === true,
)
ok(
  'BLOCK_ALL=0 凌晨仍不主动搭话',
  qD({ quietHoursBlockAll: false, proactiveRate: 1 }, 3, { atBot: false }).reply === false,
  `→ ${qD({ quietHoursBlockAll: false, proactiveRate: 1 }, 3, { atBot: false }).reason}`,
)
ok(
  'quietHours 留空 = 不启用，凌晨也回',
  decideReply({ isPrivate: false, atBot: true, groupId: 200000019, config: mk({ quietHours: '' }), lastProactive: new Map(), now: at(3) }).reply === true,
)
ok('静音群优先于安静时段（理由应是静音）', D(muted([200000019]), { quietHours: QUIET }).reason.includes('静音'))

ok('私聊必回', decideReply({ isPrivate: true, atBot: false, groupId: undefined, config: never, lastProactive: new Map() }).reply === true)
ok(
  '群内被@必回（即使概率为 0）',
  decideReply({ isPrivate: false, atBot: true, groupId: 200000019, config: never, lastProactive: new Map() }).reason === '群内被@',
)
ok(
  '非白名单群且未被@ → 忽略',
  decideReply({ isPrivate: false, atBot: false, groupId: 123456, config: always, lastProactive: new Map() }).reason === '非白名单群且未被@',
)
ok(
  '白名单群概率 1 → 必主动',
  decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: always, lastProactive: new Map() }).reason === '白名单群主动搭话',
)
ok(
  '白名单群概率 0 → 未抽中',
  decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: never, lastProactive: new Map() }).reason === '白名单群未抽中',
)

console.log('\n=== 3. 按群独立概率真的生效 ===')
{
  const cfg = mk({ proactiveRate: 0, proactiveRatePerGroup: new Map([[200000019, 1]]) })
  const a = decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: cfg, lastProactive: new Map() })
  const b = decideReply({ isPrivate: false, atBot: false, groupId: 200000017, config: cfg, lastProactive: new Map() })
  ok('独立配置为 1 的群会主动', a.reason === '白名单群主动搭话', `→ ${a.reason}`)
  ok('同一次调用里，未配置的群仍按全局 0 → 不主动', b.reason === '白名单群未抽中', `→ ${b.reason}`)
}

console.log('\n=== 4. 安静时段 / 冷却 / @ 优先级 ===')
{
  // 这一段专门测 QUIET_HOURS_BLOCK_ALL=0 的"旧行为"（只挡主动搭话、被@仍回）。
  // 默认（BLOCK_ALL 开）的彻底静音在 1c 段测。
  const quietCfg = mk({ proactiveRate: 1, quietHours: '01:00-07:00', quietHoursBlockAll: false })
  ok(
    '安静时段内不主动搭话（BLOCK_ALL=0）',
    decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: quietCfg, lastProactive: new Map(), now: t(3, 0) }).reason === '安静时段（只回 @）',
  )
  ok(
    '安静时段内被@仍然回（BLOCK_ALL=0）',
    decideReply({ isPrivate: false, atBot: true, groupId: 200000019, config: quietCfg, lastProactive: new Map(), now: t(3, 0) }).reason === '群内被@',
  )
  ok(
    '安静时段外正常主动',
    decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: quietCfg, lastProactive: new Map(), now: t(12, 0) }).reason === '白名单群主动搭话',
  )
  // 默认（不写 quietHoursBlockAll 就是开）必须是彻底静音
  const quietDefault = mk({ proactiveRate: 1, quietHours: '01:00-07:00' })
  ok(
    '默认配置下安静时段被@也不回',
    decideReply({ isPrivate: false, atBot: true, groupId: 200000019, config: quietDefault, lastProactive: new Map(), now: t(3, 0) }).reply === false,
  )

  const cdCfg = mk({ proactiveRate: 1, proactiveCooldownMs: 30000 })
  const lastProactive = new Map()
  const first = decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: cdCfg, lastProactive, now: t(12, 0) })
  ok('概率抽中本身不写成功冷却', lastProactive.size === 0)
  lastProactive.set(200000019, t(12, 0)) // 实际发送确认后才开始冷却。
  const second = decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: cdCfg, lastProactive, now: t(12, 0) + 10000 })
  const third = decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: cdCfg, lastProactive, now: t(12, 0) + 31000 })
  ok('第一次主动', first.reply === true)
  ok('30s 内第二次被冷却拦下', second.reason === '主动搭话冷却中', `→ ${second.reason}`)
  ok('超过冷却后恢复', third.reply === true, `→ ${third.reason}`)
  ok('被@ 不受冷却限制', decideReply({ isPrivate: false, atBot: true, groupId: 200000019, config: cdCfg, lastProactive, now: t(12, 0) + 1000 }).reason === '群内被@')
}

console.log('\n=== 5. 冷却按群独立（一个群说话不冻结另一个群）===')
{
  const cfg = mk({ proactiveRate: 1, proactiveCooldownMs: 30000 })
  const lastProactive = new Map()
  decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: cfg, lastProactive, now: t(12, 0) })
  const other = decideReply({ isPrivate: false, atBot: false, groupId: 200000017, config: cfg, lastProactive, now: t(12, 1) })
  ok('另一个群不受影响', other.reply === true, `→ ${other.reason}`)
}

console.log('\n=== 6. 会话独立设置（控制台里改的那些）===')
{
  const os = await import('node:os')
  const path = await import('node:path')
  const { createChatSettings, keyToGroupId, keyToUserId } = await import('../src/chatSettings.js')
  const file = path.join(os.tmpdir(), `cs-test-${Date.now()}.json`)
  const cs = createChatSettings({ file, logger: null })

  cs.set('g200000019', { proactiveRate: 1, customPrompt: '这个群说话正式点' })
  ok('保存后能读回', cs.get('g200000019').proactiveRate === 1)
  ok('未设置过的会话用默认值', cs.get('g123').enabled === true && cs.get('g123').proactiveRate === null)
  ok('raw 只返回显式设置过的项', cs.raw('g123') === null && cs.raw('g200000019').proactiveRate === 1)
  ok('越界概率被夹紧（5 → 1）', cs.set('g2', { proactiveRate: 5 }).proactiveRate === 1)
  ok('安静时段格式校验：乱填回落默认', cs.set('g3', { quietHours: '乱填' }).quietHours === null)
  ok('安静时段留空串 = 这个会话不设安静时段', cs.set('g4', { quietHours: '' }).quietHours === '')
  ok('persona key 解析', keyToGroupId('g200000019') === 200000019 && keyToUserId('p200000007') === 200000007 && keyToGroupId('p1') === null)

  const base = mk({ proactiveRate: 1, quietHours: '01:00-07:00' })
  const run = (key, over = {}, extra = {}) =>
    decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: base, lastProactive: new Map(), chatSettings: cs, chatKey: key, now: t(12, 0), ...extra, ...over })

  cs.set('g200000019', { enabled: false })
  ok('总开关关掉 → 完全不理', run('g200000019').reason === '本会话已关闭', `→ ${run('g200000019').reason}`)
  cs.set('g200000019', { enabled: true, atReplyEnabled: false })
  ok(
    '关掉被@必回 → 被@ 也不回',
    decideReply({ isPrivate: false, atBot: true, groupId: 200000019, config: base, lastProactive: new Map(), chatSettings: cs, chatKey: 'g200000019' }).reason ===
      '本会话已关闭@/引用回复',
  )
  cs.set('g200000019', { atReplyEnabled: true, proactiveEnabled: false })
  ok('关掉主动搭话 → 不主动', run('g200000019').reason === '本会话已关闭主动搭话', `→ ${run('g200000019').reason}`)

  cs.set('g200000019', { proactiveEnabled: true, proactiveRate: 0 })
  ok('会话内概率设为 0 → 不主动', run('g200000019').reason === '白名单群未抽中', `→ ${run('g200000019').reason}`)
  cs.set('g200000019', { proactiveRate: 1 })
  ok('会话内概率设为 1 → 必主动（覆盖全局）', run('g200000019').reason === '白名单群主动搭话', `→ ${run('g200000019').reason}`)

  cs.set('g200000019', { quietHours: '' })
  ok('会话内清空安静时段 → 深夜也会主动', run('g200000019', {}, { now: t(3, 0) }).reason === '白名单群主动搭话', `→ ${run('g200000019', {}, { now: t(3, 0) }).reason}`)
  cs.set('g200000019', { quietHours: '23:00-23:30' })
  ok(
    '会话内单独的安静时段生效（默认彻底静音）',
    run('g200000019', {}, { now: t(3, 0) }).reason === '白名单群主动搭话' && run('g200000019', {}, { now: t(23, 10) }).reason === '安静时段（全部静音）',
    `→ 23:10 时是 ${run('g200000019', {}, { now: t(23, 10) }).reason}`,
  )

  const noCs = decideReply({ isPrivate: false, atBot: false, groupId: 200000019, config: base, lastProactive: new Map(), now: t(12, 0) })
  ok('不传 chatSettings 时行为不变（向后兼容）', noCs.reason === '白名单群主动搭话', `→ ${noCs.reason}`)

  cs.remove('g200000019')
  ok('重置后回到默认', cs.get('g200000019').proactiveRate === null)
}

console.log('\n=== 7. 手动群总结指令识别（用线上那一份正则）===')
{
  const { SUMMARY_CMD_RE } = await import('../src/bot.js')
  const should = [
    ['/群总结', 1], ['／群总结', 1], ['群总结', 1], ['  /群总结  ', 1],
    ['/群总结 7', 7], ['/群总结 d 7', 7], ['/群总结d7', 7], ['/群总结。', 1], ['/群总结！', 1],
    ['/群聊总结 14', 14], ['今日总结', 1], ['/每日总结 3', 3], ['/群总结 30', 30],
  ]
  const shouldNot = ['总结里记得把我写帅点🍥', '大家总结一下', '我看看群总结', '/群总结 7天', '/群总结 abc', '总结']
  let bad = 0
  for (const [text, days] of should) {
    const m = text.match(SUMMARY_CMD_RE)
    const got = m ? Math.max(1, Math.min(30, Number(m[2]) || 1)) : null
    if (got !== days) {
      bad++
      console.log(`     ❌ ${JSON.stringify(text)} 应识别为 ${days} 天，实际 ${got}`)
    }
  }
  ok('常见指令写法都能识别', bad === 0, `→ 覆盖 ${should.length} 种写法`)
  const wrong = shouldNot.filter((t) => SUMMARY_CMD_RE.test(t))
  ok('普通聊天不会被误判成指令', wrong.length === 0, wrong.length ? `→ 误判：${wrong.join(' / ')}` : `→ 已排除 ${shouldNot.length} 种`)
  ok('超范围天数会被夹到 30 天以内', Math.min(30, Number('/群总结 99'.match(SUMMARY_CMD_RE)[2])) === 30)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
