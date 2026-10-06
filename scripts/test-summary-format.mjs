import assert from 'node:assert/strict'
import { parseSummaryFormat } from '../src/summaryFormat.js'
import { splitReportBlocks, buildReportBlocks, chunkReportBlocks } from '../src/dailySummary.js'

// 三个小节和相邻条目都没有空行，实际曾因此黏在一条消息里。
const glued = [
  '💬 热门话题',
  '1. 第一件事', '   参与者: 甲、乙', '   事情起因。', '   同一话题的后续。',
  '2. 第二件事', '   参与者: 丙', '   第二件事的说明。',
  '🏆 群友称号',
  '• 甲 - 活跃担当 (ENFP)', '  真实发言数据和点评。',
  '• 乙 - 灵感担当 (ENTP)', '  另一位群友的理由。',
  '💬 群圣经',
  '1. "第一行', '第二行', '2. "这行仍然属于原话"', '🏆 群友称号', '最后一句" —— 甲', '   原话的点评。',
  '2. "另一句原话" —— 乙', '   第二句的点评。',
].join('\n')
const parsed = parseSummaryFormat(glued)
assert.deepEqual(parsed.counts,{topics:2,members:2,quotes:2})
assert.deepEqual(parsed.headings,['topics','members','quotes'])
assert.equal(parsed.blocks.length,6)
assert.equal(parsed.blocks[0],'💬 热门话题\n1. 第一件事\n   参与者: 甲、乙\n   事情起因。\n   同一话题的后续。')
assert.ok(parsed.blocks[2].startsWith('🏆 群友称号\n• 甲'))
assert.ok(parsed.blocks[4].includes('第二行\n2. "这行仍然属于原话"\n🏆 群友称号\n最后一句" —— 甲\n   原话的点评。'))
assert.ok(parsed.blocks[5].startsWith('2. "另一句原话"'))
const paragraph = splitReportBlocks('💬 热门话题\n1. 一个话题\n参与者: 甲\n第一段说明\n\n第二段说明\n2. 另一个话题\n参与者: 乙\n另一段说明')
assert.equal(paragraph.length,2)
assert.ok(paragraph[0].includes('第一段说明\n\n第二段说明'))
const literal = splitReportBlocks('💬 群圣经\n1. "第一行\\n2. \\"引文里的编号\\"\\n最后一行" —— 甲\n  点评。\n2. "下一条真实原话" —— 乙')
assert.equal(literal.length,2)
assert.ok(literal[0].includes('第一行\n2.'))
assert.ok(literal[0].includes('最后一行" —— 甲\n  点评。'))
assert.equal(splitReportBlocks(String.raw`第一行\n\n第二行`).length,1)
assert.deepEqual(splitReportBlocks('普通第一段\n下一行\n\n普通第二段'),['普通第一段\n下一行','普通第二段'])
assert.deepEqual(splitReportBlocks(glued.replace(/\n/g,'\r\n')),parsed.blocks)
const stats={total:100,people:2,chars:300,emoji:3,peak:'19:00-20:00'}
const report=buildReportBlocks({startKey:'2026-10-02',endKey:'2026-10-02',stats,modelText:glued})
assert.equal(report.length,8)
assert.deepEqual(chunkReportBlocks(report,3).flat(),report)
console.log('Summary format checks passed: glued entries, section boundaries, complete descriptions, multiline quotes, quoted numbering/headings, literal escapes, Windows newlines, forward-card preservation')
