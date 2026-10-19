// 合成记录与模型替身：不连接QQ或付费服务。
import assert from 'node:assert/strict'
import {profileSummaryContent,summaryDetailPolicy,selectSummaryRecords} from '../src/summaryContent.js'
import {inspectSummaryQuality,generateCheckedSummary} from '../src/summaryQuality.js'
import {isSummaryTransientError} from '../src/summaryFailure.js'
import {computeSummaryStats} from '../src/summaryStats.js'
let passed=0
const logger={info(){},warn(){}}
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
const long='大家先说明问题的起因，然后比较不同方案的条件与限制。甲提出具体建议，乙补充自己的尝试并回应此前的疑问，两人又讨论了后续安排和没有解决的问题。'.repeat(6)
const report=(body=long,participants='甲、乙',title='方案讨论')=>'💬 热门话题\n'+Array.from({length:8},(_,i)=>`${i+1}. ${title}${i}\n参与者: ${participants}\n${body}`).join('\n\n')+'\n\n🏆 群友称号\n• 甲 - 称号\n数据\n\n• 乙 - 称号\n数据\n\n• 丙 - 称号\n数据\n\n💬 群圣经\n1. "原话一" —— 甲\n点评\n\n2. "原话二" —— 乙\n点评\n\n3. "原话三" —— 丙\n点评'
const records=Array.from({length:2200},(_,i)=>({id:String(i+1),time:1700000000+i,userId:String(i%3+1),name:['甲','乙','丙'][i%3],text:`讨论证据${i}：针对问题补充不同条件，比较方案并给出具体回应。`}))
const profile=profileSummaryContent(records),context={records,stats:{people:3},contentProfile:profile}
await test('大样本条目数够但正文只有几句，仍应要求补充细节',()=>{
 const thin=inspectSummaryQuality(report('大家聊了这个话题，气氛很热闹。'),context)
 assert.equal(thin.ok,false);assert.ok(thin.issues.some(x=>x.includes('正文过薄')))
 assert.equal(thin.fatalIssues.length,0);assert.equal(inspectSummaryQuality(report(),context).ok,true)
 assert.equal(summaryDetailPolicy(profile).target,'300～500')
})
await test('标题、参与名单和称号再长也不能充当话题正文',()=>{
 const r=inspectSummaryQuality(report('没展开。','甲、乙、丙','很长的标题'.repeat(30)),context)
 assert.equal(r.ok,false);assert.ok(r.topicBodies.every(n=>n<10))
})
await test('少量材料或重复刷屏不强制凑出长正文',()=>{
 const sparse=profileSummaryContent(records.slice(0,4)),repeats=profileSummaryContent(Array.from({length:2500},()=>({text:'同一句重复的短消息'})))
 assert.equal(summaryDetailPolicy(sparse).check,false);assert.equal(summaryDetailPolicy(repeats).check,false)
 assert.ok(repeats.evidenceChars<30)
})
await test('已知机器人播报不计真人讨论，原始统计保持不变',()=>{
 const all=[...records,...Array.from({length:2000},(_,i)=>({id:'bot'+i,userId:'9',name:'播报机器人',text:'活动通知'+i}))]
 const p=profileSummaryContent(all,{botUsers:['9']})
 assert.equal(p.ordinaryCount,2200);assert.equal(p.botCount,2000);assert.equal(computeSummaryStats(all).total,4200)
 assert.ok(p.people.find(x=>x.userId==='9').bot)
})
await test('单个机器人公告和虚构群成员不能充作多人热门讨论',()=>{
 const all=[...records,{userId:'9',name:'播报机器人',text:'发布一条通知'}],p=profileSummaryContent(all,{botUsers:['9']})
 const c={...context,contentProfile:p}
 const q=inspectSummaryQuality(report(long,'播报机器人、群成员','宿舍卫生通知'),c)
 assert.equal(q.ok,false);assert.ok(q.fatalIssues.some(x=>x.includes('只有已标记机器人')));assert.ok(q.fatalIssues.some(x=>x.includes('统称')))
 assert.equal(inspectSummaryQuality(report(long,'甲','单人闲聊'),c).ok,false)
 assert.equal(inspectSummaryQuality(report(long,'甲','活动报名通知'),c).ok,true)
})
await test('同一账号多昵称仍只算一个真人，不能用两个别名伪造多人',()=>{
 const p=profileSummaryContent([...records,{userId:'1',name:'甲的新昵称',text:'这是同一人'}])
 assert.equal(inspectSummaryQuality(report(long,'甲、甲的新昵称'),{...context,contentProfile:p}).ok,false)
})
await test('采样覆盖全天并保留连续回应，机器人不会挤占普通文字优先名额',()=>{
 const all=Array.from({length:3000},(_,i)=>({id:i,userId:i%4===0?'9':'1',text:`普通文字${i}`}))
 const chosen=selectSummaryRecords(all,300,{botUsers:['9']}),ids=new Set(chosen.map(r=>r.id))
 assert.equal(chosen.length,300);assert.equal(ids.size,300);assert.ok(chosen.filter(r=>r.userId==='1').length>=270)
 assert.ok(chosen.filter(r=>ids.has(r.id-1)||ids.has(r.id+1)).length>200)
 assert.ok(chosen.some(r=>r.id<10)&&chosen.some(r=>r.id>2990));assert.ok(chosen.every((r,i)=>!i||r.id>chosen[i-1].id))
})
await test('正文过薄会自动重写一次，原始记录和具体改善要求保留',async()=>{
 const calls=[],short=report('这条只是很简短的概述。'),good=report()
 const output=await generateCheckedSummary({llm:{async chat(p,m){calls.push(m);return calls.length===1?short:good}},prompt:'要求',messages:[{role:'user',content:'原始证据'}],...context,logger})
 assert.equal(calls.length,2);assert.equal(output,good);assert.equal(calls[1][0].content,'原始证据');assert.match(calls[1].at(-1).content,/具体观点、互相回应和结果/)
})
await test('仅篇幅建议未达标不无限重写或把事实完整报告变成发送失败',async()=>{
 let calls=0
 const output=await generateCheckedSummary({llm:{async chat(){calls++;return report('简短但保留原意。')}},prompt:'要求',messages:[],...context,logger})
 assert.equal(calls,2);assert.match(output,/简短但保留原意/)
})
await test('临时模型故障额外恢复一次，持续失败严格有界',async()=>{
 let calls=0
 const output=await generateCheckedSummary({llm:{async chat(){calls++;if(calls===1)throw Object.assign(Error('server unavailable'),{status:503});return report()}},prompt:'要求',messages:[],...context,logger})
 assert.equal(calls,2);assert.match(output,/热门话题/)
 calls=0
 await assert.rejects(generateCheckedSummary({llm:{async chat(){calls++;throw Object.assign(Error('network timeout'),{code:'ETIMEDOUT'})}},prompt:'要求',messages:[],...context,logger}),/timeout/)
 assert.equal(calls,2)
})
await test('内容检查、权限、额度和容量限制不盲目重发，取消也中断恢复',async()=>{
 for(const error of [{code:'content_filter',status:503},{status:401},{status:403},{status:402},{code:'OUTPUT_LIMIT'},{code:'SUMMARY_DEADLINE'},{status:400}])assert.equal(isSummaryTransientError(error),false)
 for(const error of [{status:429},{status:503},{code:'ECONNRESET'},{name:'TimeoutError'}])assert.equal(isSummaryTransientError(error),true)
 let calls=0;const abort=new AbortController()
 const task=generateCheckedSummary({llm:{async chat(){calls++;throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'})}},prompt:'要求',messages:[],...context,logger,signal:abort.signal})
 setTimeout(()=>abort.abort(),10)
 await assert.rejects(task);assert.equal(calls,1)
})
console.log(`${passed} summary-depth and recovery cases passed; no external services.`)
