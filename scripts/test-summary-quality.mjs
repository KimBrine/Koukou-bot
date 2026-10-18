import assert from 'node:assert/strict'
import { inspectSummaryQuality, generateCheckedSummary } from '../src/summaryQuality.js'
import { splitReportBlocks, buildSummaryPrompt } from '../src/dailySummary.js'
import { profileSummaryContent, summaryTopicPolicy, formatSummaryContentGuide, selectSummaryRecords } from '../src/summaryContent.js'

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
assert.equal(inspectSummaryQuality(report({topics:2}),context).ok,false)
// Full-window counts determine the policy, even if the model's input is sampled.
for (const [count, min, target, max] of [[0,1,1,5],[10,1,1,5],[35,1,2,5],[40,1,2,5],[41,3,3,5],[199,3,3,5],[200,3,4,6],[300,3,4,6],[799,3,4,6],[800,4,6,8],[1200,4,6,8],[1999,4,6,8],[2000,6,8,10],[3000,6,8,10]]) {
  const fullRecords = Array.from({length:count},(_,i)=>({text:`文字消息${i}`,time:1700000000+i}))
  const profile = profileSummaryContent(fullRecords)
  const policy = summaryTopicPolicy(profile)
  assert.equal(policy.min,min,`minimum at ${count}`); assert.equal(policy.target,target,`target at ${count}`)
  assert.equal(policy.max,max,`maximum at ${count}`)
  assert.equal(inspectSummaryQuality(report({topics:2}),{records:fullRecords,stats}).ok,count<=40,`two-topic boundary at ${count}`)
  if (count>40) {
    assert.match(formatSummaryContentGuide(profile),new RegExp(`热门话题至少${min}项，优先${target}项，最多${max}项`))
    assert.equal(inspectSummaryQuality(report({topics:min}),{records:fullRecords,stats}).ok,true)
    assert.equal(inspectSummaryQuality(report({topics:max+1}),{records:fullRecords,stats}).ok,false)
    const sampled = selectSummaryRecords(fullRecords,20)
    assert.equal(inspectSummaryQuality(report({topics:2}),{records:sampled,stats,contentProfile:profile}).ok,false,`sampling must not relax minimum at ${count}`)
  }
}
const unreadable = Array.from({length:1200},()=>({text:'[图片]'}))
assert.equal(summaryTopicPolicy(profileSummaryContent(unreadable)).sparse,true,'image placeholders cannot provide evidence for invented topics')
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
// The observed defect: a valid-looking two-topic report must be rewritten once.
calls=[]
const fullRecords=Array.from({length:1200},(_,i)=>({text:`文字消息${i}`}))
const repaired=await generateCheckedSummary({llm:{async chat(prompt,input){calls.push(input);return calls.length===1?report({topics:2}):report({topics:5})}},prompt:'格式',messages,records:fullRecords,stats,logger})
assert.equal(calls.length,2); assert.equal(repaired,report({topics:5}))
assert.match(calls[1].at(-1).content,/优先6项/); assert.match(calls[1].at(-1).content,/话题写 4～8 项/)
assert.match(calls[1].at(-1).content,/只有 2 项，应至少 4 项/)
calls=[]
await assert.rejects(generateCheckedSummary({llm:{async chat(){calls.push(1);return report({topics:2})}},prompt:'格式',messages,records:fullRecords,stats,logger}),error=>error.code==='REPORT_INCOMPLETE')
assert.equal(calls.length,2,'still-incomplete output must not trigger unbounded retries')

// 高流量且模型输入经过采样：三项/五项不能蒙混过关，八项正文与分条可完整保留。
const busyRecords=Array.from({length:3200},(_,i)=>({text:i<2200?`普通讨论证据${i}`:'[图片]',time:1700000000+i}))
const busyProfile=profileSummaryContent(busyRecords), sampled=selectSummaryRecords(busyRecords,600)
assert.deepEqual(summaryTopicPolicy(busyProfile),{meaningful:2200,sparse:false,min:6,target:8,max:10})
for(const topics of [3,5]) assert.equal(inspectSummaryQuality(report({topics}),{records:sampled,stats,contentProfile:busyProfile}).ok,false)
for(const topics of [6,8,10]) assert.equal(inspectSummaryQuality(report({topics}),{records:sampled,stats,contentProfile:busyProfile}).ok,true)
assert.equal(inspectSummaryQuality(report({topics:5}),{records:Array.from({length:512},()=>({text:'普通文字'})),stats}).ok,true,'中等消息量仍允许五项')
const prompt=buildSummaryPrompt({botName:'测试助手',dateLabel:'测试日期',contentGuide:formatSummaryContentGuide(busyProfile)})
assert.match(prompt,/热门话题至少6项，优先8项，最多10项/)
assert.doesNotMatch(prompt,/优先写3~5项/)
for(const initialTopics of [3,5]) {
  const inputs=[]
  const generated=await generateCheckedSummary({llm:{async chat(p,input){inputs.push(input);return report({topics:inputs.length===1?initialTopics:8})}},prompt,messages,records:sampled,stats,contentProfile:busyProfile,logger})
  assert.equal(inputs.length,2);assert.equal(generated,report({topics:8}))
  assert.equal(inputs[1][0].content,messages[0].content)
  assert.match(inputs[1].at(-1).content,/话题写 6～10 项，优先8项/)
  assert.match(inputs[1].at(-1).content,/不能为了达到数量拆碎同一事件/)
  const parts=splitReportBlocks(generated)
  assert.equal(parts.length,16);assert.ok(parts[7].startsWith('8. 测试话题8'))
  assert.ok(parts[7].includes('第二行不会拆开。'))
}
console.log('Summary quality checks passed: dynamic full-window ranges, busy-group underfill repair, upper bounds, sparse groups, bounded retries and preserved message boundaries')
