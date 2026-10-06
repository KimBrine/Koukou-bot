// 模拟真实缺陷：271条消息中只有少量例行猪猪，而主要讨论是攻略与社区争议。
import assert from 'node:assert/strict'
import { summaryRoutineKind, profileSummaryContent, formatSummaryContentGuide, selectSummaryRecords, renderSummaryRecordText } from '../src/summaryContent.js'
import { inspectSummaryQuality, generateCheckedSummary } from '../src/summaryQuality.js'
import { buildSummaryPrompt, splitReportBlocks } from '../src/dailySummary.js'
import { computeSummaryStats } from '../src/summaryStats.js'
let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`) }
const start = Date.parse('2026-10-07T00:00:00+08:00') / 1000
const records = [
  ...Array.from({ length: 9 }, (_, i) => ({ id: i, userId: '10001', name: '群友', time: start + i, text: '[@3889001246] / 今日猪猪' })),
  ...Array.from({ length: 13 }, (_, i) => ({ id: 9 + i, userId: '3889001246', name: '幽幽子', time: start + 20 + i, text: '@群友 🎉 抓到一只新猪猪啦！ 【酒鬼猪】 再来一瓶 > 固定的模板故事。 > 🐝不需要@就可以玩幽幽子的方法' })),
  { id: 22, userId: '10001', name: '群友', time: start + 40, text: '诶，云猪' },
  ...Array.from({ length: 20 }, (_, i) => ({ id: 23 + i, userId: String(10001 + i % 3), name: `群友${i % 3}`, time: start + 3600 + i * 10, text: `新歌社区争议的观点${i}` })),
  ...Array.from({ length: 100 }, (_, i) => ({ id: 43 + i, userId: String(10001 + i % 3), name: `群友${i % 3}`, time: start + 7200 + i * 10, text: `攻略配置与通关办法${i}` })),
  ...Array.from({ length: 128 }, (_, i) => ({ id: 143 + i, userId: '10001', name: '群友', time: start + 9000 + i, text: '[图片]' })),
]
const profile = profileSummaryContent(records), stats = computeSummaryStats(records)
const topics = (pigFirst = false, pigBody = '少量群友零点抽猪猪并查询库存。') => {
  const entries = [
    '攻略交流\n参与者: 群友\n群友讨论配队、卡费和打断技能，并交换通关办法。',
    '新歌争议\n参与者: 群友\n群友讨论歌曲与剧情的适配，以及社区对歌手的迁怒。',
  ]
  if (pigFirst) entries.unshift(`猪猪收集大作战\n参与者: 群友\n${pigBody}`)
  else if (pigBody) entries.push(`猪猪例行打卡\n参与者: 群友\n${pigBody}`)
  return '💬 热门话题\n' + entries.map((e, i) => `${i + 1}. ${e}`).join('\n\n') +
    '\n\n🏆 群友称号\n' + Array.from({ length: 4 }, (_, i) => `• 群友${i} - 称号\n根据真实数据。`).join('\n\n') +
    '\n\n💬 群圣经\n' + Array.from({ length: 3 }, (_, i) => `${i + 1}. "攻略配置与通关办法${i}" —— 群友\n点评。`).join('\n\n')
}
test('原始消息与普通讨论、例行指令和结果分别计数', () => {
  assert.equal(profile.total, 271); assert.equal(profile.counts['pig-command'], 9); assert.equal(profile.counts['pig-result'], 13)
  assert.equal(profile.ordinaryCount, 121); assert.equal(profile.pigDiscussionCount, 1); assert.equal(stats.total, 271)
})
test('低占比例行猪猪被识别为次要动态', () => { assert.equal(profile.minorPigRoutine, true) })
test('普通猪猪讨论、图片与误带斜杠的聊天不会被当作固定模板', () => {
  for (const text of ['我又抽到酒鬼猪了怎么办？', '我说/今日猪猪是这个指令', '签到活动要怎么报名？', '[图片]']) assert.equal(summaryRoutineKind({ text }), null)
})
test('可识别带@和空格的猪猪指令', () => { assert.equal(summaryRoutineKind({ text: '[@3889001246] / 我的猪圈' }), 'pig-command') })
test('猪圈与重复抽取结果保留真实关键值，标明不是原话', () => {
  assert.match(renderSummaryRecordText({ text: '【 @群友 的猪圈】 📦 已收集：50 / 211 ⭐ 收集率：23.70%' }), /已收集 50 \/ 211.*非原话/)
  assert.match(renderSummaryRecordText({ text: '@群友 💫 这是你第2次抓到这只猪猪啦~ 【云猪】Lv.2 > 🐝不需要@就可以玩幽幽子的方法' }), /云猪，第2次.*非原话/)
})
test('固定模板压缩不会影响完整统计或普通消息内容', () => {
  assert.ok(renderSummaryRecordText(records[9]).length < records[9].text.length)
  assert.equal(renderSummaryRecordText(records[43]), records[43].text); assert.equal(computeSummaryStats(records).total, 271)
})
test('时间分布覆盖早晚主要交流，统计不是话题断言', () => {
  const guide = formatSummaryContentGuide(profile)
  assert.ok(guide.includes('22 条（指令 9、固定回复 13）')); assert.ok(guide.includes('8.1%'))
  assert.ok(guide.includes('普通文字聊天 100 条')); assert.ok(guide.includes('不是程序认定的单一话题'))
  assert.ok(guide.includes('两项有分量的主要讨论')); assert.ok(guide.includes('不要为了通常的3～5项数量'))
})
test('少量例行猪猪占首位或长篇展开会触发修正', () => {
  const quality = inspectSummaryQuality(topics(true, '模板故事'.repeat(35)), { records, stats })
  assert.equal(quality.ok, false)
  assert.ok(quality.issues.some(s => s.includes('不应排在'))); assert.ok(quality.issues.some(s => s.includes('最多90字')))
})
test('短猪猪动态放在最后可以保留', () => { assert.equal(inspectSummaryQuality(topics(), { records, stats }).ok, true) })
test('真实讨论集中时允许两项，仍阻止大批记录只写一项', () => {
  assert.equal(inspectSummaryQuality(topics(false, ''), { records, stats }).ok, true)
  const onlyOne = topics(false, '').replace(/\n\n2\. 新歌争议[\s\S]*?(?=\n\n🏆)/, '')
  assert.equal(inspectSummaryQuality(onlyOne, { records, stats }).ok, false)
})
test('猪猪占主要聊天或引出大量真人讨论时仍可做主话题', () => {
  const mostlyRoutine = profileSummaryContent(records.slice(0, 22))
  assert.equal(mostlyRoutine.minorPigRoutine, false)
  const realConversation = [...records, ...Array.from({ length: 20 }, (_, i) => ({ time: start + 10000 + i, text: '讨论猪猪收集规则和隐藏条件' }))]
  assert.equal(profileSummaryContent(realConversation).minorPigRoutine, false)
})
test('只发生例行打卡时不强求三项话题或真实交流', () => {
  const quality = inspectSummaryQuality(topics(false, ''), { records: records.slice(0, 22), stats: { people: 4 } })
  assert.equal(quality.min.topics, 1); assert.equal(quality.min.quotes, 1)
})
test('预算内完整保留记录；预算外保留所有普通文字再补上下文', () => {
  assert.equal(selectSummaryRecords(records, 300), records)
  const selected = selectSummaryRecords(records, 150)
  assert.equal(selected.length, 150); assert.equal(new Set(selected.map(r => r.id)).size, 150)
  assert.ok(records.filter(r => !summaryRoutineKind(r) && r.text !== '[图片]').every(r => selected.includes(r)))
})
test('普通聊天也超预算时覆盖首尾和中间，保持时间顺序', () => {
  const long = Array.from({ length: 1000 }, (_, i) => ({ id: i, text: `普通聊天${i}`, time: start + i }))
  const selected = selectSummaryRecords(long, 100)
  assert.equal(selected.length, 100); assert.equal(selected[0].id, 0); assert.equal(selected.at(-1).id, 999)
  assert.ok(selected.some(r => r.id >= 400 && r.id <= 600)); assert.ok(selected.every((r, i) => !i || r.id > selected[i - 1].id))
})
test('提示词要求全局选题、克制打卡篇幅和保留真实反应', () => {
  const prompt = buildSummaryPrompt({ botName: '口', dateLabel: '2026-10-07', stats, contentGuide: formatSummaryContentGuide(profile) })
  assert.match(prompt, /先通读整个时间窗口/); assert.match(prompt, /不能写出记录没有的/); assert.match(prompt, /最多90字/)
})
const outputs = [topics(true, '模板故事'.repeat(35)), topics(false, '')], calls = []
const result = await generateCheckedSummary({ llm: { async chat(prompt, input) { calls.push(input); return outputs[calls.length - 1] } },
  prompt: '完整要求', messages: [{ role: 'user', content: '全部原始记录' }], records, stats, contentProfile: profile, logger: { info() {}, warn() {} } })
test('内容失衡自动修正一次，保留原记录并解释具体问题', () => {
  assert.equal(calls.length, 2); assert.equal(result, outputs[1]); assert.ok(calls[1].at(-1).content.includes('22/271'))
  assert.equal(calls[1][0].content, '全部原始记录'); assert.equal(splitReportBlocks(result).length, 9)
})
console.log(`Summary content checks passed: ${passed}`)
