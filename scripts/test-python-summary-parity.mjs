// Offline contracts only: no QQ connection, HTTP request, credentials or model calls.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {analyzeText,computeSummaryStats} from '../src/summaryStats.js'
import {parseSummaryFormat} from '../src/summaryFormat.js'
import {profileSummaryContent,summaryTopicPolicy} from '../src/summaryContent.js'
import {mergeRecords} from '../src/dailySummary.js'
import {parseMessage} from '../src/cq.js'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const texts=['普通文字','😀👨‍👩‍👧‍👦','[表情:微笑][图片]','a b\n[语音][视频]','💀🍥[表情：笑哭]','[合并聊天记录]','\u{1FAE9}©™♥']
const groups=[[],[{userId:'11',name:'甲',text:'你好😀',time:1700000000},{userId:'12',name:'乙',text:'[表情:微笑]',time:1700000001,replyId:'1'}],Array.from({length:65},(_,i)=>({userId:String(11+i%4),name:['甲','乙','丙','播报机器人'][i%4],text:i%10===0?'/今日猪猪':i%9===0?'[图片]':'讨论项目演示的不同观点'+i,time:1700000000+i*60})),[{userId:'11',name:'甲',text:'[合并聊天记录]',time:1700000000,forwards:[{type:'forward',data:{id:'x'}}]}]]
const reports=['第一段\n\n第二段','💬 热门话题\n1. 演示安排\n参与者: 甲、乙\n甲提出安排。\n\n乙给出建议。\n2. 设备准备\n参与者: 乙、丙\n设备已经准备。\n\n🏆 群友称号\n• 甲 - 安排员 (INTP)\n说了两条。\n\n💬 群圣经\n1. "明天演示\n2. 不要把这句当编号\n热门话题\n仍是原话" —— 甲\n一句点评。','💬 热门话题\n1. 标题\n参与者: 甲\n正文里有字面量\\n不拆条。\n\n🏆 群友称号\n• 甲 - 称号 (INTP)\n理由\n\n💬 群圣经\n暂无合适原话。']
const messages=['你好[CQ:at,qq=42][CQ:face,id=66][CQ:image,file=a]','[CQ:at,qq=11]  多空格\n下一行[CQ:reply,id=9]',[{type:'text',data:{text:'你好\n世界'}},{type:'face',data:{id:'66'}},{type:'at',data:{qq:'42'}}],[{type:'face',data:{id:'9999',raw:{faceText:'/知识增加'}}},{type:'record',data:{file:'audio'}}],[{type:'json',data:{data:JSON.stringify({app:'com.tencent.multimsg',meta:{detail:{resid:'forward-1',summary:'讨论预览'}}})}}]]
const merge={history:[{id:'1',time:10,text:'旧',replyId:'9'},{id:'2',time:20,text:'截止'}],captured:[{id:'1',time:10,text:'新'}],start:10,end:20}
const code=`import json,sys
from koukou.summary_basics import analyze_text,summary_stats,parse_summary_format,content_profile,topic_policy
from koukou.summary_history import merge_records
from koukou.messages import parse_message
d=json.load(sys.stdin)
def message(raw):
 p=parse_message(raw,'42')
 return {'text':p.text,'atBot':p.at_bot,'replyId':p.reply_id,'forwards':p.forwards}
profiles=[content_profile(g,['14']) for g in d['groups']]
print(json.dumps({'texts':[analyze_text(t) for t in d['texts']],'stats':[summary_stats(g) for g in d['groups']],'reports':[parse_summary_format(r) for r in d['reports']],'profiles':profiles,'policies':[topic_policy(p) for p in profiles],'messages':[message(m) for m in d['messages']],'merge':merge_records(**d['merge'])},ensure_ascii=False))`
const run=spawnSync(process.env.KOUKOU_PYTHON||'python',['-X','utf8','-c',code],{cwd:root,encoding:'utf8',input:JSON.stringify({texts,groups,reports,messages,merge}),env:{...process.env,PYTHONPATH:path.join(root,'python'),PYTHONUTF8:'1'},windowsHide:true})
assert.equal(run.status,0,run.stderr)
const actual=JSON.parse(run.stdout)
assert.deepEqual(actual.texts,texts.map(analyzeText))
assert.deepEqual(actual.stats,groups.map(computeSummaryStats))
assert.deepEqual(actual.reports,reports.map(parseSummaryFormat))
const profiles=groups.map(records=>profileSummaryContent(records,{botUsers:['14']}))
assert.deepEqual(actual.profiles,JSON.parse(JSON.stringify(profiles)))
assert.deepEqual(actual.policies,profiles.map(summaryTopicPolicy))
assert.deepEqual(actual.merge,mergeRecords(merge.history,merge.captured,merge.start,merge.end))
assert.deepEqual(actual.messages,messages.map(raw=>{const {text,atBot,replyId,forwards}=parseMessage(raw,'42');return {text,atBot,replyId,forwards}}))
console.log('Summary parity passed: emoji counts, full-window statistics, semantic blocks, content profiles, topic budgets, history merge and message parsing.')
