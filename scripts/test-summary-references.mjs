// 临时捕获记录、模拟图片和模型，不向 QQ 发送，不访问图片或付费接口。
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {prepareSummaryReferences,createSummaryVisionClient} from '../src/summaryReferences.js'
import {createDailySummary,mergeRecords,buildSummaryPrompt} from '../src/dailySummary.js'
import {createImageCache} from '../src/imageCache.js'
import {computeSummaryStats} from '../src/summaryStats.js'
import {profileSummaryContent,summaryTopicPolicy} from '../src/summaryContent.js'
import {inspectSummaryQuality,generateCheckedSummary,limitSummaryReferenceWeight} from '../src/summaryQuality.js'
import {parseMessage} from '../src/cq.js'

const logger={info(){},warn(){},error(){}}
const text=value=>({type:'text',data:{text:value}}),forward=id=>({type:'forward',data:{id}})
const picture={type:'image',data:{file:'0123456789abcdef0123456789abcdef.png',url:'https://example.invalid/image'}}
const node=(name,message)=>({sender:{user_id:200000099,nickname:name},time:100,message})
const part={type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgo='}}
const dir=mkdtempSync(path.join(os.tmpdir(),'koukou-summary-references-'))
const record={id:'1',userId:'200000011',name:'转发者',time:Math.floor(Date.now()/1000),text:'[合并聊天记录]',forwards:[forward('outer')]}
let passed=0
async function test(name,fn){await fn();passed++;console.log(`PASS ${name}`)}
const run=options=>prepareSummaryReferences({onebot:{async getForwardMsg(){return {messages:[node('外部人物',[text('这是转发资料'),picture])]}}},
  logger,mainChars:40000,loadImage:async()=>part,visionLLM:{model:'qwen3.8-flash',baseUrl:'https://example.invalid',async describeImages(){return '图片中的考试通知'}} ,...options,
  records:[...(options?.records??[record]),...(options?.records??[record]).map(r=>({id:`reply-${r.id}`,replyId:r.id,time:r.time+10,userId:'200000012',text:'这份资料与报名安排有关'}))]})
const report='💬 热门话题\n1. 报名安排\n   参与者: 甲、乙\n   甲通知报名截止时间，乙确认已报名；分享的资料补充了集合地点。\n\n🏆 群友称号\n• 甲 - 通知员\n  按本群两条消息说明。\n\n• 乙 - 行动派\n  按本群一条消息说明。\n\n💬 群圣经\n1. "我已报名" —— 乙\n   直接行动。'
try {
  await test('群总结图片客户端固定使用通义千问，与聊天识图、正文模型独立',async()=>{
    assert.equal(createSummaryVisionClient({config:{},logger}),null)
    const c=createSummaryVisionClient({config:{dashscopeApiKey:'qwen-key',dashscopeBaseUrl:'https://example.invalid',dashscopeModel:'qwen3.8-flash',
      summaryProvider:'deepseek',visionProvider:'deepseek',dashscopeThinking:false},logger})
    assert.equal(c.model,'qwen3.8-flash');assert.equal(c.apiKey,'qwen-key');assert.equal(c.enableThinking,false)
    assert.equal(c.timeoutMs,20000);assert.equal(c.maxRetries,0)
    const original=globalThis.fetch;let body
    try{globalThis.fetch=async(_,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'图片内容'}}]}))}
      assert.equal(await c.describeImages('p','u',[part]),'图片内容');assert.equal(body.enable_thinking,false)
      assert.equal(body.messages[1].content[1].type,'image_url')
    }finally{globalThis.fetch=original}
  })
  await test('嵌套记录与图片进入参考资料，原记录、人数、字数与选题样本不变',async()=>{
    const before=structuredClone(record), stats=computeSummaryStats([record]), calls=[]
    const result=await run({onebot:{async getForwardMsg(id){
      calls.push(id)
      const messages=id==='outer' ? [node('外部甲',[text('外部线索'),forward('inner')])] : [node('外部乙',[text('嵌套细节'),picture])]
      return {messages}
    }}})
    assert.deepEqual(calls,['outer','inner']);assert.match(result.text,/嵌套细节/);assert.match(result.text,/图片中的考试通知/)
    assert.match(result.text,/不能|不得/);assert.equal(result.imagesRead,1)
    assert.deepEqual(record,before);assert.deepEqual(computeSummaryStats([record]),stats)
    assert.equal(stats.total,1);assert.equal(stats.people,1);assert.equal(stats.chars,0)
    assert.equal(profileSummaryContent([record]).ordinaryCount,0)
  })
  await test('重复表情包跨卡片与多次总结共用哈希和描述缓存，换模型只重新识图',async()=>{
    let downloads=0,descriptions=0
    const cache=createImageCache({dir:path.join(dir,'images'),logger})
    const vision={model:'qwen3.8-flash',baseUrl:'https://example.invalid',async describeImages(){descriptions++;return '图片中的考试通知'}}
    const options={imageCache:cache,visionLLM:vision,loadImage:async()=>{downloads++;return part},records:[record,{...record,id:'2',forwards:[forward('another')]}]}
    await run(options);await run(options);assert.equal(downloads,1);assert.equal(descriptions,1)
    vision.model='另一个视觉型号';await run(options);assert.equal(downloads,1);assert.equal(descriptions,2)
  })
  await test('没有密钥或读图失败只标记未知资料，仍能保留文字并继续总结',async()=>{
    let downloads=0
    const missing=await run({visionLLM:null,loadImage:async()=>{downloads++;return part}})
    assert.equal(downloads,0);assert.equal(missing.incomplete,true);assert.match(missing.text,/未读取/)
    const failed=await run({visionLLM:{async describeImages(){throw Error('图片服务失败')}}})
    assert.equal(failed.incomplete,true);assert.match(failed.text,/读取失败/);assert.match(failed.text,/这是转发资料/)
  })
  await test('参考图片为零时不调用模型；篇幅及来源数量有限制并明确节选',async()=>{
    let calls=0
    const result=await run({maxImages:0,visionLLM:{async describeImages(){calls++;return '不应调用'}}})
    assert.equal(calls,0);assert.equal(result.imagesRead,0)
    const many=await run({records:Array.from({length:20},(_,i)=>({...record,id:String(i),forwards:[forward(String(i))]})),
      mainChars:10000,maxChars:600,maxCards:12,maxImages:0})
    assert.ok(many.expanded<=3);assert.equal(many.incomplete,true);assert.match(many.text,/节选/)
  })
  await test('资料局部超时取消视觉请求和排队，保留普通总结流程的位置',async()=>{
    const original=globalThis.fetch
    const c=createSummaryVisionClient({config:{dashscopeApiKey:'test',dashscopeBaseUrl:'https://example.invalid',dashscopeModel:'qwen3.8-flash'},logger})
    let aborted=false
    try{globalThis.fetch=async(_,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(options.signal.reason)},{once:true}))
      const result=await run({visionLLM:c,timeoutMs:30});assert.equal(result.incomplete,true);assert.ok(aborted)
      assert.equal(c.active,0);assert.match(result.text,/未读|节选/)
    }finally{globalThis.fetch=original}
  })
  await test('单群总时限取消会抛回上层，不在取消后继续展开或识图',async()=>{
    const controller=new AbortController(),reason=new Error('单群取消')
    const task=run({signal:controller.signal,onebot:{getForwardMsg(){return new Promise(()=>{})}}})
    const rejection=assert.rejects(task,e=>e===reason);controller.abort(reason);await rejection
  })
  await test('旧捕获缺少转发字段时从历史补齐，源消息依旧按ID去重',()=>{
    const merged=mergeRecords([record],[{...record,forwards:undefined}],0)
    assert.equal(merged.length,1);assert.equal(merged[0].forwards[0].data.id,'outer')
  })
  await test('仅有转发资料时不凑话题或群圣经；一般样本的话题数量规则保持',async()=>{
    const profile=profileSummaryContent([record])
    assert.equal(summaryTopicPolicy(profile).min,0)
    assert.equal(summaryTopicPolicy(profileSummaryContent([{...record,text:'转发给大家看看 [合并聊天记录]'}])).min,0,'仅转发附带一句说明也不能被强迫独立成题')
    const sparse='💬 热门话题\n暂无足够的本群交流，转发资料不单列。\n\n🏆 群友称号\n• 转发者 - 分享者\n  本群发言1条。\n\n💬 群圣经\n暂无本群可引用的原话。'
    assert.equal(inspectSummaryQuality(sparse,{records:[record],stats:{people:1}}).ok,true)
    assert.equal(inspectSummaryQuality(report,{records:[record],stats:{people:1}}).ok,false)
    const regular=Array.from({length:100},(_,i)=>({text:`本群讨论${i}`}))
    assert.equal(summaryTopicPolicy(profileSummaryContent([...regular,record])).min,3)
    const bad=report.replace('1. 报名安排','1. 转发内容解读'),ctx={records:[...regular,record],stats:{people:2}}
    assert.ok(inspectSummaryQuality(bad,ctx).issues.some(i=>i.includes('不能单列')))
    let calls=0
    const result=await generateCheckedSummary({llm:{async chat(){return ++calls===1?bad:report.replace('1. 报名安排','1. 本群报名安排')+'\n\n2. "我已报名" —— 乙\n直接行动。\n\n3. "我已报名" —— 乙\n直接行动。'}},
      prompt:'p',messages:[],records:[record],stats:{people:2},contentProfile:{...profile,forwardOnly:false,ordinaryCount:2},logger})
    assert.equal(calls,2);assert.match(result,/本群报名安排/)
  })
  await test('完整群总结路径：捕获、分页、嵌套读图、写正文，统计只有外层原消息',async()=>{
    const start=new Date();start.setHours(0,0,0,0);const sec=start.getTime()/1000
    const packets=[{message_id:10,message_seq:10,time:sec-60,user_id:200000011,message:[text('昨日')]},
      {message_id:11,message_seq:11,time:sec+10,user_id:200000011,sender:{nickname:'甲'},message:[forward('outer')]},
      {message_id:12,message_seq:12,time:sec+20,user_id:200000011,sender:{nickname:'甲'},message:[{type:'reply',data:{id:'11'}},text('明天报名截止')]},
      {message_id:13,message_seq:13,time:sec+30,user_id:200000012,sender:{nickname:'乙'},message:[text('我已报名')]}]
    let input,prompt,bodyCalls=0,visionCalls=0,sends=0
    const cfg={dataDir:path.join(dir,'daily'),summaryEnabled:true,summaryGroups:[200000002],whitelistGroups:new Set(),summaryMaxMessages:600,summaryMaxBlocks:20,summarySendMode:'forward',summaryUserRows:20,botName:'测试机器人'}
    const ob={selfId:'999',getGroupMsgHistory:async()=>({messages:packets}),getForwardMsg:async id=>({messages:id==='outer'?[node('外部甲',[forward('inner')])]:[node('外部乙',[text('旧资料'),picture])]}),
      sendGroup:async()=>{sends++},sendGroupForward:async()=>{sends++;return {message_id:100}}}
    const summary=createDailySummary({config:cfg,logger,onebot:ob,loadImage:async()=>part,visionLLM:{model:'qwen3.8-flash',async describeImages(){visionCalls++;return '图片中的考试通知'}},
      llm:{async chat(p,m){prompt=p;input=m[0].content;bodyCalls++;return report}}})
    summary.capture({...packets[1],group_id:200000002,message_type:'group'},parseMessage(packets[1].message,null))
    const filename=new Date().toLocaleDateString('sv-SE')+'.jsonl'
    assert.ok(JSON.parse(readFileSync(path.join(cfg.dataDir,'daily','200000002',filename),'utf8')).forwards.length)
    await summary.runSummary(200000002,{dryRun:true})
    assert.equal(sends,0);assert.equal(bodyCalls,1);assert.equal(visionCalls,1)
    assert.match(input,/低权重转发参考资料/);assert.match(input,/图片中的考试通知/)
    assert.match(prompt,/统计概览：今天共 3 条消息、2 人参与/);assert.match(prompt,/不把内层人物列入参与者/)
    const stats=await summary.previewStats(200000002)
    assert.equal(stats.stats.total,3);assert.equal(stats.stats.people,2)
  })
  await test('参考句严格限制在正文20%及60字以内，标记不发到群，其他小节保持原文',()=>{
    const make=ref=>'💬 热门话题\n1. 报名安排\n   参与者: 甲、乙\n   '+ '群内讨论。'.repeat(30)+'〔参考〕'+ref+'〔/参考〕'+'\n\n💬 群圣经\n1. "真实原话" —— 乙'
    const short=limitSummaryReferenceWeight(make('资料补充了地点。'),logger)
    assert.match(short,/资料补充了地点/);assert.doesNotMatch(short,/〔参考〕|〔\/参考〕/)
    const tooLong=limitSummaryReferenceWeight(make('外部材料'.repeat(30)),logger)
    assert.doesNotMatch(tooLong,/外部材料/);assert.match(tooLong,/'真实原话'|"真实原话"/)
    assert.doesNotMatch(limitSummaryReferenceWeight(make('材料'.repeat(25)),logger),/材料/,'未达60字但超过20%也要省略')
    assert.equal(limitSummaryReferenceWeight(report,logger),report)
    const literalQuote=make('资料补充了地点。').replace('"真实原话"','"真实原话〔参考〕不是内部标记〔/参考〕"')
    assert.match(limitSummaryReferenceWeight(literalQuote,logger),/"真实原话〔参考〕不是内部标记〔\/参考〕"/,'群圣经里的真实原话不能改')
  })
  console.log(`${passed} cases passed`)
}finally{
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('koukou-summary-references-'))
  rmSync(dir,{recursive:true,force:true})
}
