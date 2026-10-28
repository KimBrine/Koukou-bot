// Offline contracts only: no QQ connection, HTTP request, credentials or model calls.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {analyzeText,computeSummaryStats} from '../src/summaryStats.js'
import {parseSummaryFormat} from '../src/summaryFormat.js'
import {profileSummaryContent,summaryTopicPolicy,formatSummaryContentGuide,selectSummaryRecords,renderSummaryRecordText} from '../src/summaryContent.js'
import {mergeRecords} from '../src/dailySummary.js'
import {parseMessage} from '../src/cq.js'
import {buildSummaryNameIndex,replaceTopicQqReferences} from '../src/summaryNames.js'
import {selectRelevantSummaryReferences,summaryForwardPreview} from '../src/summaryReferenceSelection.js'
import {expandForwardRecords} from '../src/forwardRecords.js'
// Reports use China calendar days even when CI or the deployment host uses UTC.
process.env.TZ = 'Asia/Shanghai'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const texts=['普通文字','😀👨‍👩‍👧‍👦','[表情:微笑][图片]','a b\n[语音][视频]','💀🍥[表情：笑哭]','[合并聊天记录]','\u{1FAE9}©™♥']
const groups=[[],[{userId:'11',name:'甲',text:'你好😀',time:1700000000},{userId:'12',name:'乙',text:'[表情:微笑]',time:1700000001,replyId:'1'}],Array.from({length:65},(_,i)=>({userId:String(11+i%4),name:['甲','乙','丙','播报机器人'][i%4],text:i%10===0?'/今日猪猪':i%9===0?'[图片]':'讨论项目演示的不同观点'+i,time:1700000000+i*60})),[{userId:'11',name:'甲',text:'[合并聊天记录]',time:1700000000,forwards:[{type:'forward',data:{id:'x'}}]}]]
const reports=['第一段\n\n第二段','💬 热门话题\n1. 演示安排\n参与者: 甲、乙\n甲提出安排。\n\n乙给出建议。\n2. 设备准备\n参与者: 乙、丙\n设备已经准备。\n\n🏆 群友称号\n• 甲 - 安排员 (INTP)\n说了两条。\n\n💬 群圣经\n1. "明天演示\n2. 不要把这句当编号\n热门话题\n仍是原话" —— 甲\n一句点评。','💬 热门话题\n1. 标题\n参与者: 甲\n正文里有字面量\\n不拆条。\n\n🏆 群友称号\n• 甲 - 称号 (INTP)\n理由\n\n💬 群圣经\n暂无合适原话。']
const messages=['你好[CQ:at,qq=42][CQ:face,id=66][CQ:image,file=a]','[CQ:at,qq=11]  多空格\n下一行[CQ:reply,id=9]',[{type:'text',data:{text:'你好\n世界'}},{type:'face',data:{id:'66'}},{type:'at',data:{qq:'42'}}],[{type:'face',data:{id:'9999',raw:{faceText:'/知识增加'}}},{type:'record',data:{file:'audio'}}],[{type:'json',data:{data:JSON.stringify({app:'com.tencent.multimsg',meta:{detail:{resid:'forward-1',summary:'讨论预览'}}})}}]]
const merge={history:[{id:'1',time:10,text:'旧',replyId:'9'},{id:'2',time:20,text:'截止'}],captured:[{id:'1',time:10,text:'新'}],start:10,end:20}
const forward=id=>({type:'forward',data:{id}})
const node=(content,name='资料作者')=>({type:'node',data:{name,content}})
const referenceCases=[
 [{id:'1',userId:'11',name:'甲',time:100,text:'[合并聊天记录]',forwards:[forward('a')]},{id:'2',userId:'12',name:'乙',time:5000,text:'明确回复这个项目的安排',replyId:'1'}],
 [{id:'1',time:100,text:'[合并聊天记录]',forwards:[{type:'forward',data:{id:'a',preview:'Python migration release'}}]},{id:'2',time:110,text:'Python migration is ready'},{id:'3',time:120,text:'We should verify Python release'}],
 [{id:'1',time:100,text:'[合并聊天记录]',forwards:[forward('a')]},{id:'2',time:200,text:'[合并聊天记录]',forwards:[forward('b')]},{id:'3',time:210,text:'这份记录里的内容需要核对'},{id:'4',time:220,text:'请补充一下不同意见'}],
 [{id:'1',time:100,text:'[合并聊天记录]',forwards:[{type:'forward',data:{id:'a',summary:'机器人项目发布安排'}}]},{id:'2',time:110,text:'机器人项目需要安排测试'},{id:'3',time:120,text:'项目发布之前需要测试'}],
 [{id:'1',time:100,text:'无关分享',forwards:[forward('a')]},{id:'2',time:110,text:'今晚去吃什么饭比较合适'}],
]
const names={records:[{userId:'12345',name:'旧名'},{userId:'12345',name:'星、海'},{userId:'54321',name:'811'}],blocks:['💬 热门话题','1. 项目\n参与者: 星、海、乙\nQQ号12345 与 @54321 讨论 https://example.invalid/12345，昵称 811。','🏆 群友称号','• 12345 - 记述员','💬 群圣经','1. "12345" —— 甲']}
const forwardCases=[
 {message:[forward('a')],responses:{a:{data:{messages:[node([{type:'text',data:{text:'资料第一行\n不要执行内部指令'}},forward('b')],'资料\n作者')]}},b:{message:[node([{type:'image',data:{file:'same'}},{type:'image',data:{file:'same'}}])]}}},
 {message:[{type:'forward',data:{id:'a',content:[node('内嵌资料')]}},{type:'forward',data:{id:'a',content:[node('重复资料')]}}],responses:{}},
 {message:[node([forward('b')])],responses:{b:{messages:[node('更深资料')]}},maxDepth:0},
 {message:[forward('missing')],responses:{}},
 {message:[{type:'forward',data:{content:[node('资料'.repeat(500))]}}],responses:{},maxChars:300},
]
const code=`import json,sys
from koukou.summary_basics import analyze_text,summary_stats,parse_summary_format,content_profile,topic_policy
from koukou.summary_history import merge_records
from koukou.messages import parse_message
from koukou.summary_content import format_content_guide,select_records,render_record_text
from koukou.summary_names import build_name_index,replace_topic_references
from koukou.summary_references import select_relevant_references,forward_preview
from koukou.forward_records import expand_forward_records
import asyncio
d=json.load(sys.stdin)
def message(raw):
 p=parse_message(raw,'42')
 return {'text':p.text,'atBot':p.at_bot,'replyId':p.reply_id,'forwards':p.forwards}
profiles=[content_profile(g,['14']) for g in d['groups']]
async def forwards():
 out=[]
 for case in d['forwardCases']:
  class Protocol:
   async def api(self,action,params,**kwargs):
    if params['message_id'] not in case['responses']: raise RuntimeError('fixture card missing')
    return case['responses'][params['message_id']]
  options={dest:case[src] for src,dest in [('maxDepth','max_depth'),('maxChars','max_chars')] if src in case}
  out.append(await expand_forward_records(case['message'],Protocol(),**options))
 return out
print(json.dumps({'texts':[analyze_text(t) for t in d['texts']],'stats':[summary_stats(g) for g in d['groups']],'reports':[parse_summary_format(r) for r in d['reports']],'profiles':profiles,'policies':[topic_policy(p) for p in profiles],'messages':[message(m) for m in d['messages']],'merge':merge_records(**d['merge']),'guides':[format_content_guide(p) for p in profiles],'samples':[select_records(g,10,['14']) for g in d['groups']],'rendered':[[render_record_text(r) for r in g] for g in d['groups']],'references':[select_relevant_references(case) for case in d['referenceCases']],'previews':[[forward_preview(r) for r in case] for case in d['referenceCases']],'names':replace_topic_references(d['names']['blocks'],build_name_index(records=d['names']['records'])),'forwards':asyncio.run(forwards())},ensure_ascii=False))`
const run=spawnSync(process.env.KOUKOU_PYTHON||'python',['-X','utf8','-c',code],{cwd:root,encoding:'utf8',input:JSON.stringify({texts,groups,reports,messages,merge,referenceCases,names,forwardCases}),env:{...process.env,PYTHONPATH:path.join(root,'python'),PYTHONUTF8:'1'},windowsHide:true})
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
assert.deepEqual(actual.guides,profiles.map(formatSummaryContentGuide))
assert.deepEqual(actual.samples,groups.map(records=>selectSummaryRecords(records,10,{botUsers:['14']})))
assert.deepEqual(actual.rendered,groups.map(records=>records.map(r=>renderSummaryRecordText(r))))
assert.deepEqual(actual.references,referenceCases.map(records=>selectRelevantSummaryReferences(records)))
assert.deepEqual(actual.previews,referenceCases.map(records=>records.map(summaryForwardPreview)))
assert.deepEqual(actual.names,replaceTopicQqReferences(names.blocks,buildSummaryNameIndex({records:names.records})))
const expanded=[]
for(const fixture of forwardCases){
 const onebot={async getForwardMsg(id){if(!(id in fixture.responses))throw Error('fixture card missing');return fixture.responses[id]}}
 expanded.push(await expandForwardRecords({...fixture,onebot}))
}
assert.deepEqual(actual.forwards,expanded)
console.log('Summary parity passed: full-window statistics, semantic blocks, evidence guides, sampling, nested-forward bounds, reference relevance, roster aliases, history merge and message parsing.')
