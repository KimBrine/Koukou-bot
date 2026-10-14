import assert from 'node:assert/strict'
import { DeepSeekClient } from '../src/deepseek.js'
import { summaryFailureMessage } from '../src/summaryFailure.js'
import { createDailySummary } from '../src/dailySummary.js'

const logger = {info(){},warn(){},error(){}}
const client = new DeepSeekClient({apiKey:'test',baseUrl:'https://example.invalid',model:'test',temperature:1,maxTokens:12000,timeoutMs:1000,maxRetries:0,maxConcurrency:1,logger,label:'总结模型'})
const originalFetch = globalThis.fetch
try {
  let requests = 0
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({error:{code:'data_inspection_failed',message:'Input text data may contain inappropriate content.'}}),{status:400}) }
  let blocked
  try { await client.chat('prompt',[]) } catch(e) { blocked = e }
  assert.equal(blocked.code,'data_inspection_failed')
  assert.equal(requests,1)
  assert.match(blocked.message,/内容检查未通过/)
  assert.match(summaryFailureMessage(blocked),/内容检查拦截/)
  assert.doesNotMatch(summaryFailureMessage(blocked),/脑子打结|稍后重试/)
  globalThis.fetch = async () => new Response(JSON.stringify({choices:[{message:{content:'unfinished report'},finish_reason:'length'}],usage:{completion_tokens:12000}}))
  await assert.rejects(client.chat('prompt',[],{rejectTruncated:true}),e => e.code === 'OUTPUT_LIMIT' && /12000/.test(e.message))
  assert.equal(await client.chat('prompt',[]),'unfinished report') // 普通聊天保持原来的行为
  globalThis.fetch = async () => new Response(JSON.stringify({choices:[{message:{content:'partial'},finish_reason:'content_filter'}]}))
  await assert.rejects(client.chat('prompt',[]),e => e.code === 'content_filter')
  assert.match(summaryFailureMessage(new DOMException('aborted','AbortError')),/超时/)
  assert.match(summaryFailureMessage({code:'OUTPUT_LIMIT'}),/输出 token 上限/)
  assert.match(summaryFailureMessage({code:'context_length_exceeded'}),/输入容量/)
  assert.match(summaryFailureMessage(new Error('网络连接异常'),'send'),/已经生成.*QQ 发送失败/)

  // 使用本地模拟记录走完整生成流程，核对群里收到的失败说明和运行锁释放。
  const now = Math.floor(Date.now()/1000), midnight = new Date()
  midnight.setHours(0,0,0,0)
  const start = Math.floor(midnight.getTime()/1000)
  const records = [
    {message_id:1,message_seq:1,time:start-60,user_id:10001,sender:{nickname:'测试群友'},message:'旧消息'},
    {message_id:2,message_seq:2,time:Math.max(start,now-5),user_id:10001,sender:{nickname:'测试群友'},message:'今日测试消息'},
  ]
  const notices = []
  const onebot = {selfId:'99999',async getGroupMsgHistory(){return {messages:records}},async sendGroup(id,text){notices.push(text)},async sendGroupForward(){throw new Error('网络连接异常')}}
  const config = {dataDir:'__missing_summary_failure_test_data__',summaryEnabled:true,summaryGroups:[200000002],whitelistGroups:new Set(),summaryMaxMessages:600,summaryMaxBlocks:20,summarySendMode:'forward',summaryUserRows:20,botName:'测试机器人'}
  const summary = createDailySummary({config,logger,onebot,llm:{async chat(prompt,messages,options){assert.equal(options.rejectTruncated,true);throw blocked}}})
  await summary.runSummary(200000002)
  assert.equal(notices.length,3)
  assert.match(notices[0],/统计版/)
  assert.match(notices[1],/消息总数: 1/)
  assert.match(notices[2],/内容检查未通过/)
  assert.doesNotMatch(notices.join('\n'),/今日测试消息|旧消息/,'降级报告不拼接原始聊天内容')
  assert.equal(summary.isRunning(200000002),false)
  let modelCalls=0, cardSends=0
  const statsService=createDailySummary({config,logger,
    onebot:{...onebot,async sendGroupForward(id,nodes){cardSends++;assert.match(nodes[0].text,/统计版/);assert.match(nodes[1].text,/消息总数: 1/);return {message_id:100}}},
    llm:{async chat(){modelCalls++;throw Error('统计版不能调用模型')}}})
  await statsService.runSummary(200000002,{statsOnly:true})
  assert.equal(modelCalls,0);assert.equal(cardSends,1)
  console.log('Summary failure checks passed: provider rejection, output limit, timeout, send failure, real notification path, no external requests or messages')
} finally { globalThis.fetch = originalFetch }
