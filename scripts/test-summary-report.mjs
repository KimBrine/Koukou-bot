/**
 * 群聊报告（统计 + 分块 + 拼装）单元测试：不联网、不发消息。
 *   node scripts/test-summary-report.mjs
 */
import {
  analyzeText,
  computeSummaryStats,
  formatUserTable,
  formatStatsBlock,
  formatReportDate,
} from '../src/summaryStats.js'
import { splitReportBlocks, chunkReportBlocks, buildReportBlocks, mergeRecords, createDailySummary } from '../src/dailySummary.js'

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

/** 造一条某个时刻的记录 */
const at = (h, m, userId, name, text, replyId = '') => ({
  time: Math.floor(new Date(2026, 8, 4, h, m, 0).getTime() / 1000),
  userId: String(userId),
  name,
  text,
  replyId,
})

console.log('\n=== 1. analyzeText：字数与表情数的口径 ===')
ok('普通文本按字计', analyzeText('今天天气不错').chars === 6)
ok('QQ 表情算 1 个字、记 1 个表情', analyzeText('[表情:笑哭]').chars === 1 && analyzeText('[表情:笑哭]').emojiTotal === 1)
ok('emoji 记 1 个表情且算 1 个字', analyzeText('好耶🍥').emojiTotal === 1 && analyzeText('好耶🍥').chars === 3)
ok('图片占位不计字也不计表情', analyzeText('[图片]').chars === 0 && analyzeText('[图片]').emojiTotal === 0)
ok('空格不计入', analyzeText('你 好 啊').chars === 3)

console.log('\n=== 2. computeSummaryStats：统计口径 ===')
const records = [
  at(13, 5, 1, '甲', '哈哈哈哈'),
  at(13, 20, 1, '甲', '[表情:doge]', 'reply-1'),
  at(13, 40, 2, '乙', '今天天气不错啊兄弟们🍥'),
  at(14, 10, 2, '乙', '确实'),
  at(14, 12, 3, '丙', '[图片]'),
]
const stats = computeSummaryStats(records)
ok('消息总数', stats.total === 5, `→ ${stats.total}`)
ok('参与人数', stats.people === 3, `→ ${stats.people}`)
ok(
  '总字符数（表情算 1 字、图片不计）',
  stats.chars === 4 + 1 + 11 + 2 + 0,
  `→ ${stats.chars}（预期 ${4 + 1 + 11 + 2 + 0}）`,
)
ok('表情总数', stats.emoji === 2, `→ ${stats.emoji}（doge + 🍥）`)
ok('最活跃时段', stats.peak === '13:00-14:00', `→ ${stats.peak}`)
ok('按发言条数排序', stats.users[0].count === 2 && stats.users.length === 3, `→ ${stats.users.map((u) => `${u.name}:${u.count}`).join(' ')}`)

const jia = stats.users.find((u) => u.name === '甲')
ok('每人平均字数', jia.avgChars === 2.5, `→ ${jia.avgChars}`)
ok('每人表情占比', jia.emojiRatio === 0.5, `→ ${jia.emojiRatio}`)
ok('每人回复比例', jia.replyRatio === 0.5, `→ ${jia.replyRatio}`)
const bing = stats.users.find((u) => u.name === '丙')
ok('全是图片的人平均 0 字', bing.avgChars === 0 && bing.emojiRatio === 0)

ok('空数据不崩', computeSummaryStats([]).total === 0 && computeSummaryStats([]).peak === '—')
ok('单条数据', computeSummaryStats([records[0]]).people === 1)

console.log('\n=== 3. 给模型的每人数据表 ===')
const table = formatUserTable(stats, { limit: 2 })
ok('按 limit 截断', table.split('\n').length === 2, `→\n${table}`)
ok('含真实数据', /发言 \d+ 条｜平均 [\d.]+ 字｜表情占比 [\d.]+｜回复比例 [\d.]+/.test(table.split('\n')[0]))

console.log('\n=== 4. 📊 基础统计区块（代码生成，数字必须与统计一致）===')
const block = formatStatsBlock(stats)
ok('标题正确', block.startsWith('📊 基础统计'))
ok('五项齐全', ['消息总数', '参与人数', '总字符数', '表情数量', '最活跃时段'].every((k) => block.includes(k)), `→\n${block}`)
ok('数字与统计一致', block.includes(`消息总数: ${stats.total}`) && block.includes(`参与人数: ${stats.people}`))
ok('用 • 作项目符号', block.split('\n').slice(1).every((l) => l.startsWith('• ')))

console.log('\n=== 5. 日期行 ===')
ok('单日格式', formatReportDate('2026-09-04') === '2026年09月04日', `→ ${formatReportDate('2026-09-04')}`)
ok('跨天格式', formatReportDate('2026-09-01', '2026-09-04') === '2026年09月01日 ~ 2026年09月04日', `→ ${formatReportDate('2026-09-01', '2026-09-04')}`)

console.log('\n=== 6. 空行分段，条目内部换行保留 ===')
const modelText = [
  '💬 热门话题',
  '1. 方舟抽卡讨论',
  '   参与者: 甲、乙',
  '   群内围绕抽卡展开讨论……',
  '',
  '2. 兼职与工资',
  '   参与者: 乙、丙',
  '   有人吐槽被强制留岗……',
  '',
  '🏆 群友称号',
  '• 甲 - 龙王 (ENFP)',
  '  发言最多，平均 5.5 字。',
  '',
  '• 乙 - 沉默终结者 (ENTJ)',
  '  回复比例仅 0.05。',
].join('\n')
const blocks = splitReportBlocks(modelText)
ok('四个自然段成为四块', blocks.length === 4, `→ ${blocks.length} 块`)
ok('标题、首个话题和参与者留在同一条', blocks[0].startsWith('💬 热门话题\n1. 方舟抽卡讨论\n   参与者: 甲、乙'))
ok('参与者与描述保留内部换行', blocks[0].includes('参与者: 甲、乙\n   群内围绕抽卡展开讨论……'))
ok('第二个话题另起一条', blocks[1].startsWith('2. 兼职与工资\n   参与者: 乙、丙'))
ok('称号和理由保留在同一条', blocks[2].includes('• 甲 - 龙王 (ENFP)\n  发言最多'))
const noBlankLines = splitReportBlocks('💬 热门话题\n1. 第一件事\n   参与者: 甲\n   描述\n2. 第二件事\n   参与者: 乙\n🏆 群友称号\n• 甲 - 称号\n  理由\n• 乙 - 称号\n  理由')
ok('漏写空行仍按条目分开，内部换行保留', noBlankLines.length === 4 && noBlankLines[0].includes('参与者: 甲\n   描述') && noBlankLines[1].startsWith('2. 第二件事') && noBlankLines[2].startsWith('🏆 群友称号\n• 甲'))
ok('Windows 换行与空白行也只按段落拆', splitReportBlocks('甲\r\n乙\r\n \t\r\n丙\r丁').join('|') === '甲\n乙|丙\n丁')
const escapedQuote = String.raw`4. "校园网还能监视手机屏幕吗\n我去，老美的nasa这么厉害\n这都能给我探测出来" —— 817匹诺曹
   因为看到校园网流量限制提示，这段原话很好笑。`
const escapedBlocks = splitReportBlocks(`${escapedQuote}\n\n5. 下一条群圣经`)
ok('字面量 \\n 显示为换行', escapedBlocks[0].includes('手机屏幕吗\n我去，老美的nasa这么厉害\n这都能给我探测出来'))
ok('字面量 \\n 不触发截断', escapedBlocks.length === 2 && escapedBlocks[0].startsWith('4.') && escapedBlocks[1].startsWith('5.'))
ok('字面量 \\r\\n 也显示为换行', splitReportBlocks(String.raw`第一行\r\n第二行`).join('') === '第一行\n第二行')
ok('字面量连续换行仍留在同一条', splitReportBlocks(String.raw`甲\n\n乙`).length === 1)

console.log('\n=== 7. 块数超限时分卡、不合并 ===')
const many = Array.from({ length: 12 }, (_, i) => `块${i}`)
const chunks = chunkReportBlocks(many, 5)
ok('分成多张卡片且每张不超限', chunks.length === 3 && chunks.every((c) => c.length <= 5), `→ ${chunks.map((c) => c.length)}`)
ok('分卡后每块内容和边界原样保留', JSON.stringify(chunks.flat()) === JSON.stringify(many))
ok('首块仍在第一张卡片', chunks[0][0] === '块0')
ok('未超限时只有一张卡片', chunkReportBlocks(many, 20).length === 1)

console.log('\n=== 8. 完整报告拼装 ===')
const report = buildReportBlocks({
  startKey: '2026-09-04',
  endKey: '2026-09-04',
  stats,
  modelText,
})
ok('标题与日期在同一条消息', report[0] === '🎯 群聊日常分析报告\n📅 2026年09月04日')
ok('基础统计整段在同一条消息', report[1] === formatStatsBlock(stats))
ok('模型正文接在统计之后', report[2].startsWith('💬 热门话题\n1. 方舟抽卡讨论'))
ok('总块数 = 标题 1 + 统计 1 + 模型段落数', report.length === 2 + blocks.length, `→ ${report.length}`)
ok('条目内部换行仍保留', report[2].includes('参与者: 甲、乙\n   群内围绕抽卡'))
ok('每块都不为空', report.every((b) => b.trim().length > 0))
ok('分卡前所有行都保留', chunkReportBlocks(report, 5).flat().length === report.length)

console.log('\n=== 9. 历史回填与实时捕获的合并（回复比例曾全变 0 的根因）===')
{
  const t = (h, m) => Math.floor(new Date(2026, 8, 4, h, m, 0).getTime() / 1000)
  const history = [
    { id: 'a', time: t(10, 0), userId: '1', name: '甲', text: '历史版本的文字', replyId: 'r-1' },
    { id: 'b', time: t(10, 5), userId: '2', name: '乙', text: '没人回复的一条', replyId: '' },
  ]
  const captured = [
    // 早期捕获的记录没有 replyId 字段（undefined），曾把历史里的 replyId 覆盖掉
    { id: 'a', time: t(10, 0), userId: '1', name: '甲', text: '实时捕获的文字' },
    { id: 'c', time: t(11, 0), userId: '3', name: '丙', text: '只有捕获没有历史', replyId: 'r-2' },
  ]
  const merged = mergeRecords(history, captured, t(9, 0))
  const a = merged.find((r) => r.id === 'a')
  ok('同一 id 以实时捕获的文本为准', a.text === '实时捕获的文字', `→ ${a.text}`)
  ok('捕获记录缺 replyId 时从历史继承', a.replyId === 'r-1', `→ ${JSON.stringify(a.replyId)}`)
  ok('历史里有、捕获里没有的保留', merged.some((r) => r.id === 'b'))
  ok('捕获里有、历史里没有的保留', merged.some((r) => r.id === 'c'))
  ok('结果按时间升序', merged.map((r) => r.id).join('') === 'abc', `→ ${merged.map((r) => r.id).join('')}`)
  const windowed = mergeRecords(history, captured, t(10, 30))
  ok('窗口之前的记录被丢弃', windowed.length === 1 && windowed[0].id === 'c', `→ ${windowed.map((r) => r.id).join('') || '（空）'}`)
  ok('空输入不崩', mergeRecords([], [], 0).length === 0)
  const stats2 = computeSummaryStats(merged)
  ok('合并后回复比例不再是 0', stats2.users.some((u) => u.replyRatio > 0), `→ ${stats2.users.map((u) => `${u.name}:${u.replyRatio}`).join(' ')}`)
}

console.log('\n=== 10. 历史翻页与报告分卡的端到端行为（本地模拟，不发 QQ）===')
{
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const start = Math.floor(midnight.getTime() / 1000)
  const msg = (id, time) => ({
    message_id: id, message_seq: id, time, user_id: 10001,
    sender: { nickname: '测试群友' }, message: '测试消息',
  })
  // 首屏故意跨过零点却漏掉今天的 2/3/6：这是 NapCat 断线恢复后的真实故障形态。
  const latest = [msg(1, start - 60), msg(4, start + 13 * 3600), msg(5, start + 14 * 3600)]
  const anchored = [msg(3, start + 12 * 3600), ...latest.slice(1)]
  const warmed = [msg(3, start + 12 * 3600), msg(6, start + 12.5 * 3600), ...latest.slice(1)]
  const older = [latest[0], msg(2, start + 11 * 3600), anchored[0]]
  const calls = []
  const cards = []
  let round = 0
  const onebot = {
    selfId: '99999',
    async getGroupMsgHistory(groupId, seq, timeout, count, reverseOrder) {
      calls.push({ groupId, seq, reverseOrder })
      if (seq === null) { round++; return { messages: latest } }
      return { messages: seq === 3 ? older : round === 1 ? anchored : warmed }
    },
    async sendGroupForward(groupId, nodes) { cards.push({ groupId, nodes }) },
    async sendGroup() { throw new Error('不应退回逐条发送') },
  }
  const config = {
    dataDir: '__missing_summary_test_data__',
    summaryEnabled: true, summaryGroups: [200000002], whitelistGroups: new Set(),
    summaryMaxMessages: 600, summaryMaxBlocks: 5, summarySendMode: 'forward',
    summaryUserRows: 20, botName: '测试机器人',
  }
  const logger = { info() {}, warn() {}, error() {} }
  const llm = { async chat() {
    return '💬 热门话题\n' + Array.from({ length: 12 }, (_, i) => `${i + 1}. 第${i + 1}件事\n   参与者: 测试群友\n   简短描述`).join('\n\n') + '\n\n🏆 群友称号\n• 测试群友 - 测试称号\n  依据真实发言数据。\n\n💬 群圣经\n1. "测试消息" —— 测试群友\n  测试点评。'
  } }
  const service = createDailySummary({ config, logger, onebot, llm })
  const preview = await service.previewStats(200000002)
  ok('首屏虽已跨过零点仍继续回溯', latest[0].time < start && calls[1].seq === 5)
  ok('首屏之后从最新 seq 显式向更早消息翻阅', calls[0].seq === null && calls[1].seq === 5 && calls[1].reverseOrder === true && calls[2].seq === 3)
  ok('缓存补齐后重复扫描直到稳定', round === 3 && preview.complete)
  ok('跨页去重且仅统计今天消息', preview.stats.total === 5, `→ ${preview.stats.total}`)
  await service.runSummary(200000002)
  ok('超长报告分成多张卡片', cards.length > 1 && cards.every((c) => c.nodes.length <= 5), `→ ${cards.map((c) => c.nodes.length)}`)
  ok('每个顶层条目保持独立节点', cards.flatMap((c) => c.nodes).filter((n) => /(?:^|\n)\d+\. 第\d+件事/.test(n.text)).length === 12)
}

console.log('\n=== 11. 历史接口失败时不发送残缺报告 ===')
{
  let sent = 0
  const service = createDailySummary({
    config: { dataDir: '__missing_summary_test_data__', summaryEnabled: true, summaryGroups: [200000002], whitelistGroups: new Set(), summaryMaxMessages: 600, summaryMaxBlocks: 20, summarySendMode: 'forward', summaryUserRows: 20, botName: '测试机器人' },
    logger: { info() {}, warn() {}, error() {} },
    onebot: { selfId: '99999', async getGroupMsgHistory() { throw new Error('断线') }, async sendGroupForward() { sent++ }, async sendGroup() { sent++ } },
    llm: { async chat() { throw new Error('不应调用模型') } },
  })
  const preview = await service.previewStats(200000002)
  ok('预览明确标记历史不完整', preview.complete === false)
  await service.runSummary(200000002)
  ok('历史不完整时不发送报告', sent === 0)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
