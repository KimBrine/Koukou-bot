import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createBot} from '../src/bot.js'
import {MemoryStore} from '../src/memory.js'
import {MessageTimeline} from '../src/messageFreshness.js'
import {createRateLimiter} from '../src/humanize.js'

const root=mkdtempSync(path.join(os.tmpdir(),'koukou-delivery-')),stores=[]
const G=200000002,B='200000010',U=200000011
const logger={info(){},warn(){},error(){},debug(){}}
let seq=0,passed=0
function fixture(over={}){
 const memory=new MemoryStore({file:path.join(root,`${++seq}.json`),limit:99,logger});stores.push(memory)
 const timeline=new MessageTimeline();timeline.begin()
 const config={whitelistGroups:new Set([G]),mutedGroups:new Set(),proactiveRate:1,proactiveCooldownMs:30000,quietHours:'',contextRememberAll:true,autoPlusOneEnabled:false,replyMaxLines:3,replyLineMaxChars:80,replyMinBudget:300,humanDelayMinMs:0,humanDelayMaxMs:0,lineGapMinMs:0,lineGapMaxMs:0,emojiKeepRate:0,...over}
 const sent=[],calls=[],counts=[];let handler=async()=> '第一句内容。\n第二句内容。\n第三句内容。',sendError=false,confirmed=true
 const limiter=createRateLimiter({perHour:25,minGapMs:0}),record=limiter.record
 limiter.record=(...args)=>{counts.push(args[0]);record(...args)}
 const onebot={selfId:B,messageTimeline:timeline,async sendGroup(g,text){if(sendError)throw Error('send failed');sent.push(text);return confirmed?{message_id:++seq}:undefined}}
 const bot=createBot({config,logger,onebot,memory,rateLimiter:limiter,buildSystemPrompt:()=> '聊天',rand:()=>.01,llm:{async chat(...args){calls.push(args);return handler(...args)}}})
 const event=(text='这是一条普通聊天消息，想听听你的意见。'.repeat(3))=>{const e={post_type:'message',message_type:'group',self_id:Number(B),group_id:G,user_id:U,message_id:++seq,time:Date.now()/1000,sender:{nickname:'群友甲'},message:[{type:'text',data:{text}}]};e.messageContext=timeline.receive(e);return e}
 return {bot,config,memory,onebot,timeline,sent,calls,counts,limiter,event,setChat:v=>handler=v,setSendError:v=>sendError=v,setConfirmed:v=>confirmed=v}
}
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
try{
 await test('寂静时段拦截群@、私聊、管理/帮助/解题指令并保留上下文',async()=>{
  const t=fixture({quietHours:'00:00-24:00'})
  for(const text of ['/help','/Q 解释这个问题','禁言我10s','帮我撤回','拍一拍我']){
   const e=t.event(text);e.message.unshift({type:'at',data:{qq:B}});await t.bot.handleMessage(e)
  }
  const p=t.event('你好');p.message_type='private';delete p.group_id;await t.bot.handleMessage(p)
  assert.equal(t.sent.length,0);assert.equal(t.calls.length,0)
  assert.equal(t.memory.get(`g${G}`).length,5);assert.equal(t.memory.get(`p${U}`).length,1)
 })
 await test('直接@生成途中进入寂静时段，迟到正文不发送',async()=>{
  const t=fixture();let done;t.setChat(()=>new Promise(r=>done=r))
  const e=t.event('你在吗');e.message.unshift({type:'at',data:{qq:B}})
  const pending=t.bot.handleMessage(e);await new Promise(setImmediate)
  assert.equal(t.calls.length,1);t.config.quietHours='00:00-24:00'
  done('这段不能在入睡后发出');await pending;assert.equal(t.sent.length,0);assert.equal(t.counts.length,0)
 })
 await test('整段三条只扣一次额度，额度剩一次仍完整发送；后续一轮才被限流',async()=>{
  const t=fixture({proactiveCooldownMs:0});const check=t.limiter.check;t.limiter.check=(k,n,o)=>check(k,n,{...o,perHourLimit:1})
  await t.bot.handleMessage(t.event());assert.equal(t.sent.length,3);assert.equal(t.counts.length,1)
  await t.bot.handleMessage(t.event('下一次聊天'));assert.equal(t.sent.length,3);assert.equal(t.calls.length,1)
 })
 await test('模型失败不占冷却，在途标记释放后下一条可立即尝试',async()=>{
  const t=fixture();t.setChat(async()=>{throw Error('model failure')});await t.bot.handleMessage(t.event())
  t.setChat(async()=> '正常回答');await t.bot.handleMessage(t.event('重试聊天'))
  assert.equal(t.calls.length,2);assert.equal(t.sent.length,1);assert.equal(t.counts.length,1)
 })
 await test('发送失败也不占冷却和小时额度',async()=>{
  const t=fixture();t.setSendError(true);await t.bot.handleMessage(t.event());assert.equal(t.counts.length,0)
  t.setSendError(false);await t.bot.handleMessage(t.event('重试发送'));assert.equal(t.calls.length,2);assert.ok(t.sent.length)
 })
 await test('私聊发送超时不额外发送模型出错提示，群聊不继续后续分条',async()=>{
  const p=fixture({privateWhitelist:new Set([U])});let attempts=0
  p.onebot.sendPrivate=async()=>{attempts++;throw Object.assign(Error('OneBot API 超时：send_private_msg'),{service:'onebot',code:'ONEBOT_TIMEOUT'})}
  const e=p.event('你好');e.message_type='private';delete e.group_id
  await p.bot.handleMessage(e);assert.equal(attempts,1)
  const g=fixture();let calls=0
  g.onebot.sendGroup=async()=>{calls++;throw Object.assign(Error('OneBot API 超时：send_group_msg'),{service:'onebot',code:'ONEBOT_TIMEOUT'})}
  await g.bot.handleMessage(g.event());assert.equal(calls,1);assert.equal(g.counts.length,0)
 })
 await test('成功发送才进入冷却，紧接普通消息不再生成',async()=>{
  const t=fixture();await t.bot.handleMessage(t.event());await t.bot.handleMessage(t.event('马上再说话'))
  assert.equal(t.calls.length,1);assert.equal(t.counts.length,1)
 })
 await test('未确认回执不当作成功，不扣额度也不占冷却',async()=>{
  const t=fixture();t.setConfirmed(false);await t.bot.handleMessage(t.event());assert.equal(t.counts.length,0)
  t.setConfirmed(true);await t.bot.handleMessage(t.event('稍后新话题'));assert.equal(t.calls.length,2);assert.equal(t.counts.length,1)
 })
 await test('普通插话不取消生成，同群不并行抽出多轮',async()=>{
  const t=fixture();let done;t.setChat(()=>new Promise(r=>done=r))
  const first=t.bot.handleMessage(t.event());await new Promise(setImmediate)
  await t.bot.handleMessage(t.event('插话'));assert.equal(t.calls.length,1)
  done('听到了，接着刚才说。');await first;assert.equal(t.sent.length,1)
 })
 await test('断线重连仍取消旧轮次，迟到任务不会占新会话冷却',async()=>{
  const t=fixture();let done;t.setChat(()=>new Promise(r=>done=r))
  const old=t.bot.handleMessage(t.event());await new Promise(setImmediate);t.timeline.end();t.timeline.begin()
  t.setChat(async()=> '重新登录后的回答');await t.bot.handleMessage(t.event('重新登录的新消息'))
  done('旧回答');await old;assert.deepEqual(t.sent,['重新登录后的回答']);assert.equal(t.counts.length,1)
 })
 await test('部分发送后失败整段仍只计一次，且已发送部分开始冷却',async()=>{
  const t=fixture();let n=0;const send=t.onebot.sendGroup;t.onebot.sendGroup=async(...a)=>{if(++n===2)throw Error('later failure');return send(...a)}
  await t.bot.handleMessage(t.event());assert.equal(t.sent.length,1);assert.equal(t.counts.length,1)
  await t.bot.handleMessage(t.event('再次讲话'));assert.equal(t.calls.length,1)
 })
 await test('同段touch不增加小时计数，但更新末条发送的最小间隔',()=>{
  const l=createRateLimiter({perHour:2,minGapMs:4000});l.record('g',10000);l.touch('g',13000)
  assert.equal(l.check('g',14000).retryAfterMs,3000);assert.equal(l.check('g',18000).allowed,true)
  l.record('g',18000);assert.equal(l.check('g',23000).allowed,false)
 })
 await test('主动生成中发生静音、移出白名单、人格切换或超龄仍禁止发送',async()=>{
  for(const kind of ['mute','whitelist','persona','expired']){
   const t=fixture();let done;t.setChat(()=>new Promise(r=>done=r))
   const pending=t.bot.handleMessage(t.event());await new Promise(setImmediate)
   if(kind==='mute')t.config.mutedGroups.add(G)
   if(kind==='whitelist')t.config.whitelistGroups.delete(G)
   if(kind==='persona')t.config.personaRevision=1
   if(kind==='expired')t.timeline.now=()=>Date.now()+91000
   done('不能迟到发送');await pending;assert.equal(t.sent.length,0,kind);assert.equal(t.counts.length,0,kind)
  }
 })
 await test('主动回复在途不阻塞被@的直接对话',async()=>{
  const t=fixture();let done;t.setChat(()=>new Promise(r=>done=r))
  const pending=t.bot.handleMessage(t.event());await new Promise(setImmediate)
  t.setChat(async()=> '我在听呢。');const at=t.event('你在吗');at.message.unshift({type:'at',data:{qq:B}})
  await t.bot.handleMessage(at);assert.equal(t.calls.length,2);assert.deepEqual(t.sent,['我在听呢。'])
  done('刚才的话我听到了。');await pending;assert.equal(t.sent.length,2);assert.equal(t.counts.length,2)
 })
 await test('短消息预算只引导生成，发送和记忆保留完整尾句',async()=>{
  const t=fixture({replyLineMaxChars:12,replyMinBudget:0})
  const full='前面这部分说明原因，后面这部分也需要把完整意思表达清楚'
  t.setChat(async()=>full)
  await t.bot.handleMessage(t.event('为什么'))
  assert.equal(t.sent.join(''),full)
  assert.ok(t.memory.get('g'+G).some(m=>m.role==='assistant'&&m.content===full))
 })
 console.log(`${passed} delivery cases passed; no QQ or model API calls.`)
}finally{for(const m of stores)if(m.timer)clearTimeout(m.timer);assert.equal(path.dirname(root),os.tmpdir());rmSync(root,{recursive:true,force:true})}
