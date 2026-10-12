// 模拟 OneBot、模型与图片；不连接 QQ、不下载图片、不调用付费模型。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createBot } from '../src/bot.js'
import { MemoryStore, modelHistory } from '../src/memory.js'
import { MessageTimeline } from '../src/messageFreshness.js'
import { backlogLength } from '../src/replyShape.js'
import { createQuotedMessageResolver } from '../src/quotedMessage.js'
import { computeSummaryStats } from '../src/summaryStats.js'
import { profileSummaryContent } from '../src/summaryContent.js'

const group=200000002,selfId='200000010',user=200000011
const logger={info(){},warn(){},debug(){},error(){}}
const text=t=>({type:'text',data:{text:t}}), at=()=>({type:'at',data:{qq:selfId}})
const quote=id=>({type:'reply',data:{id:String(id)}}),forward=id=>({type:'forward',data:{id}})
const node=(name, content)=>({sender:{nickname:name,user_id:200000020},time:1,message:content})
const dir=mkdtempSync(path.join(os.tmpdir(),'koukou-context-')),stores=[]
let files=0,ids=1000,passed=0
async function test(name,fn){await fn();passed++;console.log(`PASS ${name}`)}
function setup({config={},getMsg,forwards={},chat,chatSettings,rateLimiter,visionLLM}={}) {
  let time=Math.floor(Date.now()/1000)*1000
  const timeline=new MessageTimeline({now:()=>time});timeline.begin()
  const memory=new MemoryStore({file:path.join(dir,`${++files}.json`),limit:99,logger});stores.push(memory)
  const sent=[],requests=[],lookups=[],forwardReads=[],captured=[]
  const onebot={selfId,messageTimeline:timeline,
    async sendGroup(g,t){sent.push(t);return {message_id:++ids}},async sendPrivate(u,t){sent.push(t);return {message_id:++ids}},
    async getMsg(id){lookups.push(id);return getMsg?getMsg(id):{message_id:id,group_id:group,user_id:selfId,sender:{nickname:'测试机器人',user_id:selfId},message:[text('之前的答案')]}},
    async getForwardMsg(id){forwardReads.push(id);if(forwards[id] instanceof Error)throw forwards[id];return {messages:forwards[id]??[]}},
  }
  const cfg={whitelistGroups:new Set([group]),mutedGroups:new Set(),proactiveRate:0,proactiveCooldownMs:0,
    quietHours:'',contextRememberAll:true,autoPlusOneEnabled:false,replyMaxLines:3,replyLineMaxChars:40,
    humanDelayMinMs:0,humanDelayMaxMs:0,lineGapMinMs:0,lineGapMaxMs:0,emojiKeepRate:0,replyLengthMatch:true,
    visionMaxImages:2,rateLimitAtPerHour:45,...config}
  const bot=createBot({config:cfg,logger,onebot,memory,chatSettings,rateLimiter,visionLLM,rand:()=>0.5,
    buildSystemPrompt:()=> '群聊人设',llm:{async chat(...args){requests.push(args);return chat?chat(...args):'明白了，继续聊呀'}},
    dailySummary:{capture(evt){captured.push(evt.message_id)},summaryGroups:()=>[group]}})
  function event(message,extra={}){const evt={post_type:'message',message_type:'group',user_id:user,group_id:group,
    message_id:++ids,time:time/1000,sender:{nickname:'群友甲'},message:typeof message==='string'?[text(message)]:message,...extra}
    evt.messageContext=timeline.receive(evt);return evt}
  return {bot,memory,cfg,timeline,onebot,sent,requests,lookups,forwardReads,captured,event,advance:ms=>{time+=ms},time:()=>time}
}
const lastUser=t=>t.requests.at(-1)[1].at(-1).content
const shape=t=>t.requests.at(-1)[0].match(/【本次回复的形态要求[^]*?(?=\n\n【|$)/)?.[0]
try {
  await test('主动概率为零、没有@、不在白名单，引用机器人消息仍直接回复',async()=>{
    const t=setup({config:{whitelistGroups:new Set()}})
    await t.bot.handleMessage(t.event([quote(42),text('接着说呢')]))
    assert.equal(t.requests.length,1);assert.equal(t.sent.length,1);assert.deepEqual(t.lookups,['42'])
    assert.match(lastUser(t),/之前的答案/);assert.match(lastUser(t),/接着说呢/)
  })
  await test('引用其他群友、未知作者或其他群的消息，不伪装为直接回复',async()=>{
    for(const result of [{user_id:user},{sender:{}},{user_id:selfId,group_id:group+1}]){
      const t=setup({getMsg:id=>({message_id:id,message:[text('其他消息')],...result})})
      await t.bot.handleMessage(t.event([quote(42),text('接着说呢')]))
      assert.equal(t.requests.length,0);assert.equal(t.sent.length,0)
    }
  })
  await test('CQ格式引用无需@，只有引用段也能回应机器人',async()=>{
    for(const message of ['[CQ:reply,id=42]继续',[quote(42)]]){
      const t=setup();await t.bot.handleMessage(t.event(message,{message}));assert.equal(t.sent.length,1)
    }
  })
  await test('引用和@同时存在只调用一次模型，取回引用也只查询一次',async()=>{
    const t=setup();await t.bot.handleMessage(t.event([quote(42),at(),text('继续')]))
    assert.equal(t.requests.length,1);assert.equal(t.sent.length,1);assert.equal(t.lookups.length,1)
  })
  await test('已收到的机器人消息优先复用；接口不可用时仍能识别引用',async()=>{
    const t=setup({getMsg:()=>{throw Error('不可用')}})
    const own=t.event('机器人原话',{user_id:Number(selfId),sender:{nickname:'测试机器人'}})
    await t.bot.handleMessage(own)
    await t.bot.handleMessage(t.event([quote(own.message_id),text('继续')]))
    assert.equal(t.lookups.length,0);assert.equal(t.sent.length,1);assert.match(lastUser(t),/机器人原话/)
  })
  await test('发送回执进入引用缓存，没有自身消息上报也能识别刚发的答案',async()=>{
    const t=setup({getMsg:()=>{throw Error('不可用')}})
    await t.bot.handleMessage(t.event([at(),text('你好')]))
    const receiptId=ids
    await t.bot.handleMessage(t.event([quote(receiptId),text('继续')]))
    assert.equal(t.sent.length,2);assert.equal(t.lookups.length,0)
  })
  await test('引用仍遵守会话关闭、直接回复关闭、静音及全静音时段',async()=>{
    const cases=[{config:{mutedGroups:new Set([group])}},
      {config:{quietHours:'00:00-23:59'}},
      {chatSettings:{get:()=>({enabled:false}),resolve:()=>({})}},
      {chatSettings:{get:()=>({enabled:true,atReplyEnabled:false}),resolve:()=>({})}}]
    for(const opts of cases){const t=setup(opts);await t.bot.handleMessage(t.event([quote(42),text('继续')]))
      assert.equal(t.requests.length,0);assert.equal(t.sent.length,0)}
  })
  await test('引用使用直接对话的额度，不被主动回复的每小时额度挡住',async()=>{
    const checks=[];const rateLimiter={check(k,n,opts){checks.push(opts);return {allowed:opts?.perHourLimit===45}},record(){}}
    const t=setup({rateLimiter});await t.bot.handleMessage(t.event([quote(42),text('继续')]))
    assert.equal(t.sent.length,1);assert.ok(checks.every(o=>o.perHourLimit===45))
  })
  await test('群内新消息不会取消正在生成的直接引用回复，断线仍取消',async()=>{
    for(const disconnect of [false,true]){
      let release;const t=setup({chat:()=>new Promise(resolve=>{release=resolve})})
      const task=t.bot.handleMessage(t.event([quote(42),text('继续')]))
      await new Promise(setImmediate);assert.ok(release)
      if(disconnect){t.timeline.end();t.advance(1000);t.timeline.begin()}
      else await t.bot.handleMessage(t.event('别人插话'))
      release('这是直接回复');await task;assert.equal(t.sent.length,disconnect?0:1)
    }
  })
  await test('登录补读的旧引用不查询目标、不调用模型、不补答',async()=>{
    const t=setup();await t.bot.handleMessage(t.event([quote(42),text('旧问题')],{time:t.time()/1000-3600}))
    assert.equal(t.lookups.length,0);assert.equal(t.requests.length,0);assert.equal(t.sent.length,0)
  })
  await test('合并记录含嵌套与多个节点：外层一次捕获、一次记忆、一次生成',async()=>{
    const t=setup({forwards:{outer:[node('甲',[text('外层内容'),forward('inner')]),node('乙',[text('后续内容')])],inner:[node('丙',[text('嵌套内容')])]}})
    await t.bot.handleMessage(t.event([at(),text('怎么看'),forward('outer')]))
    assert.equal(t.requests.length,1);assert.equal(t.sent.length,1);assert.equal(t.captured.length,1)
    assert.equal(t.memory.get(`g${group}`).filter(m=>m.role==='user').length,1)
    assert.match(lastUser(t),/外层内容/);assert.match(lastUser(t),/嵌套内容/);assert.match(lastUser(t),/后续内容/)
    assert.deepEqual(t.forwardReads,['outer','inner'])
  })
  await test('纯卡片不再丢掉；内层@、引用和指令不触发额外回复或命令',async()=>{
    const t=setup({forwards:{outer:[node('甲',[at(),quote(42),text('/群总结')])]}})
    await t.bot.handleMessage(t.event([forward('outer')]))
    assert.equal(t.requests.length,0);assert.equal(t.lookups.length,0)
    assert.equal(t.captured.length,1);assert.equal(t.memory.get(`g${group}`).filter(m=>m.role==='user').length,1)
    assert.match(t.memory.get(`g${group}`)[0].content,/群总结/)
    await t.bot.handleMessage(t.event([at(),forward('outer')]))
    assert.equal(t.requests.length,1);assert.equal(t.sent.length,1)
  })
  await test('引用机器人发出的合并卡片无需@即可递归读取',async()=>{
    const t=setup({getMsg:id=>({message_id:id,user_id:selfId,message:[forward('outer')]}),forwards:{outer:[node('甲',[forward('inner')])],inner:[node('乙',[text('卡片里的线索')])]}})
    await t.bot.handleMessage(t.event([quote(42),text('这个怎么看')]))
    assert.equal(t.requests.length,1);assert.match(lastUser(t),/卡片里的线索/);assert.equal(t.sent.length,1)
  })
  await test('多层嵌套只抽一次主动概率，未命中只阅读；命中只生成一次',async()=>{
    const original=Math.random
    try {
      for(const randomValue of [0.9,0.1]){
        let draws=0;Math.random=()=>randomValue
        const t=setup({config:{proactiveRateFor(){draws++;return 0.2}},forwards:{outer:[node('甲',[forward('inner')]),node('乙',[forward('inner')])],inner:[node('丙',[text('嵌套讨论')])]}})
        await t.bot.handleMessage(t.event([forward('outer')]))
        assert.equal(draws,1);assert.equal(t.requests.length,randomValue<0.2?1:0)
        assert.equal(t.sent.length,randomValue<0.2?1:0);assert.equal(t.captured.length,1)
        assert.equal(t.memory.get(`g${group}`).filter(m=>m.role==='user').length,1)
      }
    } finally {Math.random=original}
  })
  await test('一条与几十条内层消息使用相同回复长度预算和行数',async()=>{
    const outputs=[]
    for(const count of [1,70]){
      const t=setup({forwards:{outer:Array.from({length:count},(_,i)=>node(`群友${i}`,[text('很长的历史聊天内容'.repeat(10))]))}})
      await t.bot.handleMessage(t.event([at(),text('怎么看'),forward('outer')]))
      assert.equal(t.requests.length,1);assert.equal(t.sent.length,1);outputs.push(shape(t))
      assert.equal(t.memory.get(`g${group}`)[0].replyLength,3)
    }
    assert.equal(outputs[0],outputs[1])
  })
  await test('未回复的大卡片也不拉长下一条回复，长度元数据重启后保留且不发给模型',async()=>{
    const t=setup({forwards:{outer:[node('甲',[text('历史资料'.repeat(1000))])]}})
    await t.bot.handleMessage(t.event([text('看看'),forward('outer')]))
    assert.equal(backlogLength(t.memory.get(`g${group}`)),2)
    t.memory.flush();const restored=new MemoryStore({file:t.memory.file,limit:99,logger});restored.load()
    assert.equal(backlogLength(restored.get(`g${group}`)),2)
    assert.ok(modelHistory(restored.get(`g${group}`)).every(m=>Object.keys(m).sort().join(',')==='content,role'))
    await t.bot.handleMessage(t.event([at(),text('怎么看')]))
    assert.equal(t.requests.length,1);assert.match(shape(t),/大约 4 字/)
    assert.match(t.requests[0][1][0].content,/历史资料/)
  })
  await test('读取失败明确说明资料缺失，不伪造聊天原文',async()=>{
    const t=setup({forwards:{outer:Error('读取失败')}})
    await t.bot.handleMessage(t.event([at(),text('怎么看'),forward('outer')]))
    assert.equal(t.requests.length,1);assert.match(lastUser(t),/失败|未能|无法/)
    assert.match(t.requests[0][0],/不能猜测/)
  })
  await test('引用缓存有上限；返回不匹配编号时不认作引用机器人',async()=>{
    let calls=0
    const resolver=createQuotedMessageResolver({onebot:{selfId,async getMsg(id){calls++;return {message_id:'mismatch',user_id:selfId}}},logger,maxEntries:1})
    resolver.remember({message_type:'group',group_id:group,user_id:selfId,message_id:1,message:[text('旧答案')]})
    resolver.remember({message_type:'group',group_id:group,user_id:selfId,message_id:2,message:[text('新答案')]})
    const evt={message_type:'group',group_id:group,user_id:user}
    assert.ok(resolver.isFromBot(await resolver.resolve(evt,2)));assert.equal(await resolver.resolve(evt,1),null);assert.equal(calls,1)
  })
  await test('私聊引用拒绝其他对话人的消息，正常双方发言仍可读取',async()=>{
    for(const [result,valid] of [[{user_id:user+1},false],[{user_id:selfId,target_id:user+1},false],
      [{user_id:selfId,target_id:user},true],[{user_id:user},true]]){
      const resolver=createQuotedMessageResolver({onebot:{selfId,async getMsg(id){return {message_id:id,message_type:'private',message:[text('私聊原文')],...result}}},logger})
      const resolved=await resolver.resolve({message_type:'private',user_id:user},42)
      assert.equal(Boolean(resolved),valid)
    }
  })
  await test('合并卡片只计一条外层消息，占位符不虚增字数或有效话题样本',()=>{
    const records=[{userId:String(user),name:'群友甲',time:1,text:'[合并聊天记录]'}]
    const stats=computeSummaryStats(records)
    assert.equal(stats.total,1);assert.equal(stats.chars,0);assert.equal(profileSummaryContent(records).ordinaryCount,0)
  })
  console.log(`${passed} cases passed`)
}finally {
  for(const memory of stores)if(memory.timer)clearTimeout(memory.timer)
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()))
  assert.ok(path.basename(dir).startsWith('koukou-context-'));rmSync(dir,{recursive:true,force:true})
}
