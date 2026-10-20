// 全部使用模拟网络，不调用 QQ 或付费模型。
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {DeepSeekClient} from '../src/deepseek.js'
import {summaryRequestTimeout} from '../src/summaryRequests.js'
import {createSummaryVisionClient} from '../src/summaryReferences.js'
import {expandForwardRecords} from '../src/forwardRecords.js'
const logger={info(){},warn(){},error(){}}
const originalFetch=globalThis.fetch
let passed=0
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
const client=()=>new DeepSeekClient({apiKey:'dummy',baseUrl:'https://example.invalid',model:'test',timeoutMs:20,maxTokens:undefined,maxRetries:1,maxConcurrency:1,logger})
const success=()=>new Response(JSON.stringify({choices:[{message:{content:'完整总结'},finish_reason:'stop'}]}))
try{
 await test('宽裕模式默认每次15分钟，可调等待且不改变其他模式',()=>{
  assert.equal(summaryRequestTimeout({summaryUnrestricted:true},123),900000)
  assert.equal(summaryRequestTimeout({summaryUnrestricted:true,summaryRequestTimeoutSeconds:1800},123),1800000)
  assert.equal(summaryRequestTimeout({summaryUnrestricted:false},123),123)
  const c=createSummaryVisionClient({config:{summaryUnrestricted:true,dashscopeApiKey:'dummy',dashscopeModel:'test'},logger})
  assert.equal(c.timeoutMs,900000);assert.equal(c.maxTokens,undefined);assert.equal(c.maxRetries,1)
 })
 await test('请求卡住（包括响应正文）会中断旧尝试，有限重试取得完整报告',async()=>{
  let requests=0,aborted=false
  globalThis.fetch=async(_,{signal})=>{
   if(++requests>1)return success()
   return {ok:true,json:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true}))}
  }
  const c=client();assert.equal(await c.chat('摘要',[],{rejectTruncated:true}),'完整总结');assert.equal(requests,2);assert.equal(aborted,true);assert.equal(c.active,0)
 })
 await test('持续无响应按重试上限停止并释放位置，下个群仍能成功',async()=>{
  let requests=0
  globalThis.fetch=async(_,{signal})=>{requests++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}
  const c=client();await assert.rejects(c.chat('摘要',[]),e=>e.name==='AbortError');assert.equal(requests,2);assert.equal(c.active,0)
  globalThis.fetch=async()=>success();assert.equal(await c.chat('另一个群',[]),'完整总结')
 })
 await test('鉴权失败不会因等待恢复策略反复请求',async()=>{
  let requests=0;globalThis.fetch=async()=>{requests++;return new Response('{}',{status:401})}
  await assert.rejects(client().chat('摘要',[]),e=>e.status===401);assert.equal(requests,1)
 })
 await test('转发临时卡住同一卡片恢复一次；持续失败不无限重试',async()=>{
  let requests=0
  const input={message:[{type:'forward',data:{id:'card'}}],unrestrictedWait:true,logger}
  const onebot={async getForwardMsg(id,timeout){assert.equal(timeout,15000);if(++requests===1)throw Error('读取超时');return {messages:[{sender:{nickname:'作者'},message:'资料'}]}}}
  const result=await expandForwardRecords({...input,onebot});assert.equal(result.failed,false);assert.equal(requests,2);assert.match(result.text,/资料/)
  requests=0;const failed=await expandForwardRecords({...input,onebot:{async getForwardMsg(){requests++;throw Error('读取超时')}}});assert.equal(failed.failed,true);assert.equal(requests,2)
 })
 await test('报告页显示宽裕开关、等待与机器人设置，旧上限标为不生效',()=>{
  const html=readFileSync(new URL('../src/admin/ui.html',import.meta.url),'utf8')
  const form=html.slice(html.indexOf('function configForm('),html.indexOf('function pageHumanize('))
  const report=html.slice(html.indexOf('function pageReport('),html.indexOf('function pageLogs('))
  const keys=['SUMMARY_UNRESTRICTED','SUMMARY_REQUEST_TIMEOUT_SECONDS','SUMMARY_BOT_USERS','SUMMARY_MAX_TOKENS','SUMMARY_TASK_TIMEOUT_MINUTES']
  const ctx={state:{config:{summaryUnrestricted:true,summaryRequestTimeoutSeconds:1800}},configItems:keys.map(key=>({key,type:key==='SUMMARY_UNRESTRICTED'?'bool':'number',effective:'1',value:'1',label:key})),chats:[],esc:String}
  vm.createContext(ctx);const output=vm.runInContext(form+report+';pageReport()',ctx)
  for(const key of keys)assert.ok(output.includes(`data-cfg="${key}"`))
  assert.match(output,/单次模型等待 1800 秒/);assert.equal((output.match(/<fieldset disabled/g)||[]).length,2)
  ctx.state.config.summaryUnrestricted=false;assert.doesNotMatch(vm.runInContext('pageReport()',ctx),/<fieldset disabled/)
 })
 console.log(`${passed} request-recovery cases passed; no external services.`)
}finally{globalThis.fetch=originalFetch}
