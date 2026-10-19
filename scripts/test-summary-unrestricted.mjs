// 模拟模型、QQ与时钟，验证宽裕模式；不连接外部服务。
import assert from 'node:assert/strict'
import {mock} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {DeepSeekClient} from '../src/deepseek.js'
import {OneBotClient} from '../src/onebot.js'
import {createSummaryDeadline} from '../src/summaryJobs.js'
import {createDailySummary} from '../src/dailySummary.js'
import {summaryTopicPolicy,formatSummaryContentGuide,profileSummaryContent,renderSummaryRecordText} from '../src/summaryContent.js'
import {expandForwardRecords} from '../src/forwardRecords.js'
const logger={info(){},warn(){},error(){}}
const originalFetch=globalThis.fetch
let passed=0
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
const client=options=>new DeepSeekClient({apiKey:'dummy',baseUrl:'https://example.invalid',model:'qwen3.8-flash',maxTokens:undefined,timeoutMs:0,maxRetries:0,maxConcurrency:1,logger,...options})
try{
 await test('不传输出token参数且0超时不会立即中断，单次预算仍可单独限制',async()=>{
  const requests=[]
  globalThis.fetch=async(url,{body,signal})=>{requests.push(JSON.parse(body));await new Promise(resolve=>setTimeout(resolve,15));assert.equal(signal.aborted,false);return new Response(JSON.stringify({choices:[{message:{content:'完整报告'},finish_reason:'stop'}]}))}
  const c=client();assert.equal(await c.chat('要求',[]),'完整报告');assert.equal(Object.hasOwn(requests[0],'max_tokens'),false)
  await c.chat('要求',[],{maxTokens:500});assert.equal(requests[1].max_tokens,500)
  await c.describeImages('读图','',[],{maxTokens:0});assert.equal(Object.hasOwn(requests[2],'max_tokens'),false)
  const limited=client({maxTokens:12000});await limited.chat('要求',[],{maxTokens:20000});assert.equal(requests[3].max_tokens,12000)
 })
 await test('未设输出限制仍识别服务商截断，不把半篇报告当完整',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'半篇'},finish_reason:'length'}]}))
  await assert.rejects(client().chat('要求',[],{rejectTruncated:true}),e=>e.code==='OUTPUT_LIMIT'&&e.message.includes('服务商自身上限'))
 })
 await test('宽裕模式等待数小时也不被本地总时限取消，仍可正常释放',async()=>{
  mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()})
  try{
   const deadline=createSummaryDeadline({summaryUnrestricted:true,summaryTaskTimeoutMinutes:2});let release
   const task=deadline.wait(new Promise(resolve=>release=resolve))
   mock.timers.tick(6*3600000);assert.equal(deadline.signal.aborted,false);release('完成');assert.equal(await task,'完成');deadline.close()
  }finally{mock.timers.reset()}
 })
 await test('OneBot读取0超时等待响应，普通读取仍保留原有超时机制',async()=>{
  const c=Object.create(OneBotClient.prototype);c.echoSeq=0;c.pending=new Map();c.ws={readyState:WebSocket.OPEN,send(){}}
  const task=c.api('get_group_msg_history',{},0)
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(c.pending.size,1);const entry=c.pending.get('1');assert.equal(entry.timer,null);entry.resolve({messages:[]});c.pending.delete('1');assert.deepEqual(await task,{messages:[]})
 })
 await test('主消息完整保留、不按120字剪掉结尾，话题数量也不设固定上限',()=>{
  const original='原文'.repeat(300)+'结尾关键决定';assert.equal(renderSummaryRecordText({text:original},{unrestricted:true}),original)
  const p=profileSummaryContent(Array.from({length:2500},(_,i)=>({text:'讨论'+i})));p.unrestricted=true
  assert.equal(summaryTopicPolicy(p).max,Infinity);assert.match(formatSummaryContentGuide(p),/不设固定条数上限/);assert.doesNotMatch(formatSummaryContentGuide(p),/Infinity/)
 })
 await test('宽裕模式的转发读取不使用短时限，但仍保留防循环与取消能力',async()=>{
  const timeouts=[]
  const result=await expandForwardRecords({message:[{type:'forward',data:{id:'card'}}],onebot:{async getForwardMsg(id,timeout){timeouts.push(timeout);await new Promise(resolve=>setTimeout(resolve,15));return {messages:[{sender:{nickname:'引用者'},message:[{type:'text',data:{text:'引用内容'}}]}]}}},unrestrictedWait:true,timeoutMs:1,requestTimeoutMs:1,logger})
  assert.equal(result.failed,false);assert.deepEqual(timeouts,[0]);assert.match(result.text,/引用内容/)
 })
 await test('完整生成路径在条数设置为50时仍输入全部千余条与长消息末尾',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'summary-unrestricted-'))
  try{
   const midnight=new Date();midnight.setHours(0,0,0,0);const start=Math.floor(midnight.getTime()/1000),now=Math.floor(Date.now()/1000)
   const packets=Array.from({length:1101},(_,i)=>({message_id:i+1,message_seq:i+1,time:i===0?start-1:Math.min(now-1,start+i),user_id:123,sender:{nickname:'甲'},message:i===1100?'长消息'.repeat(200)+'唯一末尾证据':`原始消息${i}`}))
   const inputs=[],historyTimeouts=[]
   const body='💬 热门话题\n'+Array.from({length:7},(_,i)=>`${i+1}. 真实主题${i}\n参与者: 甲\n根据证据介绍真实情况。`).join('\n\n')+'\n\n🏆 群友称号\n• 甲 - 称号\n理由\n\n💬 群圣经\n1. "原话一" —— 甲\n点评\n\n2. "原话二" —— 甲\n点评\n\n3. "原话三" —— 甲\n点评'
   const config={dataDir:dir,summaryEnabled:true,summaryGroups:[101],whitelistGroups:new Set([101]),summaryUnrestricted:true,summaryMaxMessages:50,summaryUserRows:1,summaryTaskTimeoutMinutes:2}
   const summary=createDailySummary({config,logger,onebot:{selfId:'999',async getGroupMsgHistory(g,seq,timeout){historyTimeouts.push(timeout);return {messages:packets}}},llm:{async chat(prompt,messages){inputs.push(messages[0].content);return body}}})
   await summary.runSummary(101,{dryRun:true})
   assert.ok(inputs.length>=1);assert.match(inputs[0],/原始消息1/);assert.match(inputs[0],/原始消息1099/);assert.match(inputs[0],/唯一末尾证据/);assert.equal((inputs[0].match(/原始消息/g)||[]).length,1099);assert.ok(historyTimeouts.every(t=>t===0));assert.equal(summary.isRunning(101),false)
  }finally{assert.equal(path.dirname(dir),os.tmpdir());rmSync(dir,{recursive:true,force:true})}
 })
 console.log(`${passed} unrestricted-summary cases passed; no external services.`)
}finally{globalThis.fetch=originalFetch}
