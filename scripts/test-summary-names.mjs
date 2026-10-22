// 本地模拟，不调用真实模型、不发 QQ 消息。
import assert from 'node:assert/strict'
import { buildSummaryNameIndex, replaceTopicQqReferences, resolveSummaryNames } from '../src/summaryNames.js'
import { selectSummaryRecords } from '../src/summaryContent.js'
import { buildReportBlocks, buildSummaryPrompt, createDailySummary, splitReportBlocks } from '../src/dailySummary.js'
import { computeSummaryStats } from '../src/summaryStats.js'

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`) }
const nick = '示例群友甲（昵称含表情）🍥🍥🍥'
const users = [
  { userId: '200000015', name: '示例机器人' },
  { userId: '200000007', name: '旧昵称' },
  { userId: '200000008', name: '示例群友乙（昵称含表情）🐳🐳🐳' },
]
const index = buildSummaryNameIndex({ users, records: [{ userId: '200000007', name: nick }] })
const source = [
  '💬 热门话题', '1. 猪猪收集大作战', `   参与者: 示例机器人、${nick}`,
  '   [200000007]连续发了两次指令，[200000015]接连抛出搞笑词条。\\n大家都笑了。',
  '2. 另一件事', '   参与者: 示例群友乙（昵称含表情）🐳🐳🐳', '   [200000008]也来凑热闹，[@200000015]回答了。[99999999]身份未知。',
  '🏆 群友称号', '• 示例机器人 - 活跃担当 (ENFP)', '  留下[200000015]这个原始说明。',
  '💬 群圣经', '1. "这是[200000007]的原话', '🏆 群友称号', '下一行[@200000015]" —— 示例机器人', '   引文点评。',
].join('\n')
const before = splitReportBlocks(source), after = replaceTopicQqReferences(before, index)
test('用户示例中的 QQ 号变成群昵称，括号和表情完整', () => {
  assert.ok(after[0].includes(`${nick}连续发了两次指令，示例机器人接连抛出搞笑词条。`))
})
test('优先沿用该条参与者中的跨日别名', () => { assert.ok(!after[0].includes('旧昵称')) })
test('相邻话题都替换，未列入参与者时使用记录中的昵称', () => {
  assert.ok(after[1].includes('示例群友乙（昵称含表情）🐳🐳🐳也来凑热闹，示例机器人回答了。'))
})
test('无法确认的 QQ 保持原文，不猜昵称', () => { assert.ok(after[1].includes('[99999999]')) })
test('话题编号与参与者行保留原样', () => { assert.equal(after[0].split('\n').slice(0, 3).join('\n'), before[0].split('\n').slice(0, 3).join('\n')) })
test('字面量换行解码后仍是一个话题节点', () => { assert.equal(after.length, before.length); assert.ok(after[0].endsWith('词条。\n大家都笑了。')) })
test('称号与真实多行引文完全不改，即使引文里出现小节标题', () => { assert.deepEqual(after.slice(2), before.slice(2)) })
test('参与者栏本身漏写昵称时也能补上', () => {
  const result = replaceTopicQqReferences(['💬 热门话题\n1. 讨论\n参与者: [200000015]\n[200000015]发言。'], index)
  assert.equal(result[0], '💬 热门话题\n1. 讨论\n参与者: 示例机器人\n示例机器人发言。')
})
test('每个话题单独选择参与者别名', () => {
  const result = replaceTopicQqReferences(['💬 热门话题\n1. 昨天\n参与者: 旧昵称\n[200000007]说话。', `2. 今天\n参与者: ${nick}\n[200000007]说话。`], index)
  assert.ok(result[0].endsWith('旧昵称说话。')); assert.ok(result[1].endsWith(`${nick}说话。`))
})
test('昵称中的分隔符和重叠短昵称不会造成错配', () => {
  const names = buildSummaryNameIndex({ users: [{ userId: '10001', name: '甲' }, { userId: '10002', name: '旧乙' }], records: [{ userId: '10002', name: '甲、乙' }] })
  const result = replaceTopicQqReferences(['💬 热门话题\n1. 讨论\n参与者: 甲、乙\n[10002]说话。'], names)
  assert.ok(result[0].endsWith('甲、乙说话。'))
})
test('带正则符号的昵称按普通文本匹配', () => {
  const names = buildSummaryNameIndex({ users: [{ userId: '10001', name: '旧昵称' }], records: [{ userId: '10001', name: 'a+[b](c).*' }] })
  assert.ok(replaceTopicQqReferences(['💬 热门话题\n1. 讨论\n参与者: a+[b](c).*\n[10001]说话。'], names)[0].endsWith('a+[b](c).*说话。'))
})
test('不同群同一 QQ 可使用不同群名片', () => {
  const names = buildSummaryNameIndex({ users: [{ userId: '200000015', name: '另一个群的名片' }] })
  assert.ok(replaceTopicQqReferences(before, names)[0].includes('另一个群的名片接连抛出'))
})
test('没有有效昵称时不变成空白，后续真实昵称仍可补齐', () => {
  assert.equal(buildSummaryNameIndex({ users: [{ userId: '10001', name: '10001' }] }).size, 0)
  assert.equal(buildSummaryNameIndex({ users: [{ userId: '10001', name: '10001' }], records: [{ userId: '10001', name: '群友' }] }).get('10001').name, '群友')
})
test('换行昵称不会引入额外结构', () => { assert.equal(buildSummaryNameIndex({ users: [{ userId: '10001', name: '甲\r\n乙' }] }).get('10001').name, '甲 乙') })
test('没有热门话题标题的普通文本保持原样', () => { assert.deepEqual(replaceTopicQqReferences(['文字[200000015]'], index), ['文字[200000015]']) })
test('完整报告默认利用全部统计用户，不受模型表格行数限制', () => {
  const stats = computeSummaryStats(Array.from({ length: 25 }, (_, i) => ({ userId: String(10000 + i), name: `群友${i}`, text: '消息', time: 1 })))
  const report = buildReportBlocks({ startKey: '2026-10-07', endKey: '2026-10-07', stats, modelText: '💬 热门话题\n1. 讨论\n参与者: 群友24\n[10024]也参加了。' })
  assert.ok(report[2].endsWith('群友24也参加了。')); assert.ok(report[1].includes('消息总数: 25'))
})
test('提示词明确要求正文与参与者昵称一致', () => {
  const prompt = buildSummaryPrompt({ botName: '口', dateLabel: '2026-10-07' })
  assert.ok(prompt.includes('与本条「参与者」栏的昵称完全一致'))
  assert.ok(!prompt.includes('用 [QQ号] 代替昵称'))
})
test('裸 QQ、方括号、@、QQ前缀都替换，参与者与正文一致', () => {
  const result = replaceTopicQqReferences([`💬 热门话题\n1. 讨论\n参与者: 200000007、200000015\n200000007先说，@200000015回应，QQ：200000007接着说。`], index)[0]
  assert.ok(result.includes('参与者: 旧昵称、示例机器人'))
  assert.ok(result.endsWith('旧昵称先说，示例机器人回应，旧昵称接着说。'))
})
test('200000002 卡片预览中的裸号码可以恢复该群名片', () => {
  const names = buildSummaryNameIndex({ users: [
    { userId: '200000007', name: '604 口口盐' }, { userId: '200000012', name: '707-吴钧皓' },
    { userId: '200000011', name: '904，皇帝' }, { userId: '200000009', name: '1002 Ataraxia' },
  ] })
  const result = replaceTopicQqReferences(['💬 热门话题\n1. 讨论\n参与者: 200000007、200000012、200000011、200000009\n[200000007]和200000012讨论。'], names)[0]
  assert.ok(result.includes('参与者: 604 口口盐、707-吴钧皓、904，皇帝、1002 Ataraxia'))
  assert.ok(result.endsWith('604 口口盐和707-吴钧皓讨论。'))
})
test('短数字昵称不会遮住别人的 QQ 号码', () => {
  const names = buildSummaryNameIndex({ users: [{ userId: '200000005', name: '811' }, { userId: '200000003', name: '718 镜中春' }] })
  assert.ok(replaceTopicQqReferences(['💬 热门话题\n1. 讨论\n参与者: 200000003、811\n200000003回答811。'], names)[0].endsWith('718 镜中春回答811。'))
})
test('日期、概率、网址、较长编号、已知数字昵称保持原样', () => {
  const names = buildSummaryNameIndex({ users, records: [{ userId: '10001', name: '昵称200000007号' }] })
  const original = '时间2026-10-07，20%，https://example.com/200000007\n编号918229396420，昵称200000007号。'
  assert.ok(replaceTopicQqReferences([`💬 热门话题\n1. 讨论\n参与者: 示例机器人\n${original}`], names)[0].endsWith(original))
})
let memberReads = 0
const missingNames = buildSummaryNameIndex({ users })
await resolveSummaryNames({ text: '💬 热门话题\n1. 讨论\n参与者: 10001、示例机器人\n[10001]被提到。', index: missingNames, groupId: 101,
  onebot: { async getGroupMemberList(group) { memberReads++; assert.equal(group, 101); return [{ user_id: 10001, card: '本群的静默成员', nickname: '账号昵称' }] } },
  logger: { info() {}, warn() {} },
})
test('未发言成员只补查一次该群名单，群名片优先', () => { assert.equal(memberReads, 1); assert.equal(missingNames.get('10001').name, '本群的静默成员') })
await resolveSummaryNames({ text: '💬 热门话题\n1. 讨论\n参与者: 10001\n10001被提到。', index: missingNames, groupId: 101,
  onebot: { async getGroupMemberList() { throw Error('不应重复补查') } }, logger: { info() {}, warn() {} },
})
test('已知身份不重复请求群成员名单', () => { assert.ok(missingNames.has('10001')) })
const failedIndex = new Map(), nameWarnings = []
await resolveSummaryNames({ text: '💬 热门话题\n1. 讨论\n参与者: 10002\n10002被提到。', index: failedIndex, groupId: 101,
  onebot: { async getGroupMemberList() { throw Error('查询超时') } }, logger: { info() {}, warn(message) { nameWarnings.push(message) } },
})
test('名单补查失败时不编造或丢弃报告', () => { assert.equal(failedIndex.size, 0); assert.equal(nameWarnings.length, 1) })

// 零点后半小时内，摘要的"今天"窗口刚打开，构造跨天历史会在 CI 上偶发失败；跳过这一条
const startMinutes = new Date().getHours() * 60 + new Date().getMinutes()
if (startMinutes < 30) {
  console.log('SKIP 摘要发送路径：00:00-00:30 跨天窗口')
  process.exit(0)
}
// 验证真实 runSummary 发送路径：别名只出现在被模型预算截掉的中间消息。
const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
const start = midnight.getTime() / 1000
const history = Array.from({ length: 126 }, (_, i) => ({
  message_id: i + 1, message_seq: i + 1, time: start + (i === 0 ? -60 : i), user_id: 10001,
  sender: { card: '旧名片', nickname: 'QQ昵称' },
  message: i === 1 ? '原文[10001]' : '[图片]',
}))
const selectedIds = new Set(selectSummaryRecords(history.slice(1).map(m => ({ id: m.message_id, text: m.message })), 110).map(r => r.id))
const omitted = history.slice(2).find(m => !selectedIds.has(m.message_id))
assert.ok(omitted)
omitted.sender.card = '新名片🍥'
const cards = [], errors = []
let modelCalls = 0
const service = createDailySummary({
  config: { dataDir: '__missing_summary_name_test_data__', summaryEnabled: true, summaryGroups: [101], whitelistGroups: new Set(), summaryMaxMessages: 110, summaryMaxBlocks: 20, summarySendMode: 'forward', summaryUserRows: 1, botName: '测试机器人' },
  logger: { info() {}, warn() {}, error(message) { errors.push(message) } },
  onebot: { selfId: '99999', async getGroupMsgHistory() { return { messages: history } }, async sendGroupForward(group, nodes) { cards.push({ group, nodes }); return { message_id: 900 } }, async sendGroup() { throw Error('不应逐条发送') } },
  llm: { async chat(prompt, messages) {
    modelCalls++; assert.ok(!messages[0].content.includes('新名片🍥'))
    return '💬 热门话题\n1. 讨论\n   参与者: 新名片🍥\n   [10001]开始聊天。\\n大家回应。\n\n🏆 群友称号\n• 旧名片 - 活跃担当\n  根据真实数据。\n\n💬 群圣经\n1. "原文[10001]" —— 旧名片\n   真实点评。'
  } },
})
try { await service.runSummary(101) } finally { service.stop() }
test('发送路径按截取前的完整记录替换群名片，模型只调用一次', () => {
  assert.deepEqual(errors, []); assert.equal(modelCalls, 1); assert.equal(cards.length, 1)
  assert.equal(cards[0].group, 101)
  assert.ok(cards[0].nodes[2].text.endsWith('新名片🍥开始聊天。\n大家回应。'))
})
test('发送的统计、消息边界与群圣经原话保持正确', () => {
  assert.equal(cards[0].nodes.length, 5)
  assert.ok(cards[0].nodes[1].text.includes('消息总数: 125'))
  assert.ok(cards[0].nodes[4].text.includes('"原文[10001]"'))
})
console.log(`Summary nickname checks passed: ${passed}`)
