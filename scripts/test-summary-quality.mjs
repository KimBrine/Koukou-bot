import assert from 'node:assert/strict'
import { inspectSummaryQuality, generateCheckedSummary } from '../src/summaryQuality.js'
import { splitReportBlocks } from '../src/dailySummary.js'

const logger = {info(){},warn(){}}
const records = Array.from({length:100},(_,i)=>({text:`真实测试消息${i}`}))
const stats = {people:9}
const report = ({topics=3,heading=true,members=5,quotes=3}={}) => [
  '💬 热门话题\n' + Array.from({length:topics},(_,i)=>`${i+1}. 测试话题${i+1}\n   参与者: 群友\n   同一话题里的描述\n   第二行不会拆开。`).join('\n\n'),
  (heading?'🏆 群友称号\n':'') + Array.from({length:members},(_,i)=>`• 群友${i+1} - 测试称号\n  按真实数据说明。`).join('\n\n'),
  '💬 群圣经\n' + Array.from({length:quotes},(_,i)=>`${i+1}. "真实测试消息${i}" —— 群友\n   点评。`).join('\n\n'),
].join('\n\n')

const context = {records,stats}
const incomplete = report({topics:1,heading:false,members:9,quotes:4})
assert.equal(inspectSummaryQuality(incomplete,context).ok,false)
assert.ok(inspectSummaryQuality(incomplete,context).issues.some(issue=>issue.includes('只有 1 项')))
assert.ok(inspectSummaryQuality(incomplete,context).issues.some(issue=>issue.includes('缺少「群友称号」')))
assert.equal(inspectSummaryQuality(report(),context).ok,true)
assert.equal(inspectSummaryQuality(report({members:4}),context).ok,true)
assert.equal(inspectSummaryQuality(report({members:6}),context).ok,false)
assert.equal(inspectSummaryQuality(report({members:3}),context).ok,false)
assert.equal(inspectSummaryQuality(report({topics:1,members:2,quotes:1}),{records:records.slice(0,4),stats:{people:2}}).ok,true)
assert.equal(inspectSummaryQuality(report()+'\n🏆 群友称号',context).ok,false)
assert.equal(inspectSummaryQuality(report({quotes:1}),context).ok,false)
assert.equal(inspectSummaryQuality(report({topics:1}),context).ok,false)
let calls=[]
const messages = [{role:'user',content:'原始聊天记录，必须保留'}]
const llm = {async chat(prompt,input,options){calls.push({prompt,input,options});return calls.length===1?incomplete:report()}}
const output=await generateCheckedSummary({llm,prompt:'原始格式要求',messages,...context,logger})
assert.equal(calls.length,2)
assert.deepEqual(calls[1].input[0],messages[0])
assert.equal(calls[1].input[1].role,'assistant')
assert.match(calls[1].input[2].content,/不能为了凑数编造/)
assert.equal(calls[1].options.rejectTruncated,true)
assert.equal(output,report())
const blocks=splitReportBlocks(output)
assert.equal(blocks.length,11)
assert.ok(blocks[0].includes('第二行不会拆开。'))
assert.ok(blocks[1].startsWith('2. 测试话题'))
calls=[]
await assert.rejects(generateCheckedSummary({llm:{async chat(){calls.push(1);return incomplete}},prompt:'格式',messages,...context,logger}),error=>error.code==='REPORT_INCOMPLETE')
assert.equal(calls.length,2)
calls=[]
await generateCheckedSummary({llm:{async chat(){calls.push(1);return report()}},prompt:'格式',messages,...context,logger})
assert.equal(calls.length,1)
console.log('Summary quality checks passed: exact defect, complete sections, enough topics, sparse groups, bounded repair, original records retained, preserved message boundaries')
