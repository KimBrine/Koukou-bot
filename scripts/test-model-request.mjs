// 模拟模型响应与超时，不连接模型服务。
import assert from 'node:assert/strict'
import { DeepSeekClient, isQwenHybridModel } from '../src/deepseek.js'
import { summaryFailureMessage } from '../src/summaryFailure.js'

const originalFetch = globalThis.fetch
const logger = { info() {}, warn() {}, error() {} }
const client = options => new DeepSeekClient({ apiKey:'test',baseUrl:'https://example.invalid',model:'qwen3.8-flash',
  temperature:1,maxTokens:12000,timeoutMs:1000,maxRetries:0,maxConcurrency:1,logger,...options })
const success = () => new Response(JSON.stringify({choices:[{message:{content:'完整回复'},finish_reason:'stop'}]}))
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }
try {
  await test('仅识别已支持混合思考的千问型号，不误改其他厂商或旧视觉模型', () => {
    for (const model of ['qwen3.8-flash','qwen3.7-flash-2026-07-15','qwen3.5-plus','qwen3-vl-flash','qwen-plus','qwen-flash']) assert.ok(isQwenHybridModel(model))
    for (const model of ['deepseek-flash','qwen-vl-plus','qwen3.8-max','qwen3.8-omni-flash','other-model']) assert.equal(isQwenHybridModel(model),false)
  })
  await test('文本、工具、视觉与读图请求均可关闭思考，保留输出预算', async () => {
    const bodies=[]
    globalThis.fetch=async (_, options)=>{bodies.push(JSON.parse(options.body));return success()}
    const c=client({enableThinking:false})
    await c.chat('p',[]);await c.chatRaw([]);await c.chatVision('p',[],'u',[]);await c.describeImages('p','u',[])
    assert.equal(bodies.length,4);assert.ok(bodies.every(body=>body.enable_thinking===false))
    assert.equal(bodies[0].max_tokens,12000);assert.equal(bodies[3].max_tokens,400)
  })
  await test('不配置思考时不发送扩展字段，显式开启时尊重设置', async () => {
    const bodies=[]
    globalThis.fetch=async (_, options)=>{bodies.push(JSON.parse(options.body));return success()}
    await client({model:'deepseek-flash'}).chat('p',[])
    await client({enableThinking:true}).chat('p',[])
    assert.equal(Object.hasOwn(bodies[0],'enable_thinking'),false);assert.equal(bodies[1].enable_thinking,true)
  })
  await test('只读 message 的 AbortError 不被二次 TypeError 掩盖，正确报告超时并释放并发', async () => {
    const abort=new DOMException('This operation was aborted','AbortError'), c=client()
    globalThis.fetch=async()=>{throw abort}
    await assert.rejects(c.chat('p',[]),error=>error.name==='AbortError'&&error.cause===abort&&/超时/.test(summaryFailureMessage(error)))
    assert.equal(abort.message,'This operation was aborted');assert.equal(c.active,0)
    globalThis.fetch=async()=>success();assert.equal(await c.chat('p',[]),'完整回复')
  })
  await test('请求超时覆盖收到 HTTP 头之后的响应正文，不无限等 res.json', async () => {
    const c=client({timeoutMs:20})
    globalThis.fetch=async (_, {signal})=>({ok:true,json:()=>new Promise((_,reject)=>{
      if(signal.aborted)reject(signal.reason)
      else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})
    })})
    await assert.rejects(c.chat('p',[]),error=>error.name==='AbortError'&&/超时/.test(summaryFailureMessage(error)))
    assert.equal(c.active,0)
  })
  await test('可重试 AbortError 按上限重试，最终保留真实错误类型', async () => {
    const c=client({maxRetries:1});let requests=0
    globalThis.fetch=async()=>{requests++;throw new DOMException('aborted','AbortError')}
    await assert.rejects(c.chat('p',[]),error=>error.name==='AbortError')
    assert.equal(requests,2);assert.equal(c.active,0)
  })
  await test('取消排队中的群不发起请求，也不抢占或泄漏生成位置', async () => {
    const c=client(), controller=new AbortController();let release, requests=0
    globalThis.fetch=async()=>{requests++;await new Promise(resolve=>{release=resolve});return success()}
    const first=c.chat('p',[]);await Promise.resolve();await Promise.resolve()
    const reason=Object.assign(new Error('单群总时限'),{code:'SUMMARY_DEADLINE'})
    const queued=c.chat('p',[],{signal:controller.signal})
    const rejection=assert.rejects(queued,error=>error===reason)
    controller.abort(reason);await rejection
    assert.equal(c.queue.length,0);assert.equal(requests,1);assert.equal(c.active,1)
    release();await first;assert.equal(c.active,0)
  })
  await test('单群总时限中止已开始的请求，不再重试，释放后其他群可调用', async () => {
    const c=client({maxRetries:2}), controller=new AbortController();let requests=0
    globalThis.fetch=async(_, {signal})=>{requests++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}
    const reason=Object.assign(new Error('单群总时限'),{code:'SUMMARY_DEADLINE'})
    const task=c.chat('p',[],{signal:controller.signal});const rejection=assert.rejects(task,error=>error===reason)
    await Promise.resolve();await Promise.resolve();controller.abort(reason);await rejection
    assert.equal(requests,1);assert.equal(c.active,0)
    globalThis.fetch=async()=>success();assert.equal(await c.chat('p',[]),'完整回复')
  })
  await test('总时限也能中断重试退避，不在取消后再次请求', async () => {
    const c=client({maxRetries:2}),controller=new AbortController();let requests=0
    globalThis.fetch=async()=>{requests++;throw new Error('network error')}
    const reason=new Error('cancel retries'), task=c.chat('p',[],{signal:controller.signal})
    const rejection=assert.rejects(task,error=>error===reason)
    for(let i=0;i<10;i++)await Promise.resolve()
    controller.abort(reason);await rejection;assert.equal(requests,1);assert.equal(c.active,0)
  })
  await test('两个群真正并行调用模型，一群失败时另一个仍可完成', async () => {
    const c=client({maxConcurrency:2});let release, requests=0
    globalThis.fetch=async()=>{if(++requests===1){await new Promise(resolve=>{release=resolve});throw new Error('单群失败')}return success()}
    const first=c.chat('p',[]), rejection=assert.rejects(first,/单群失败/)
    assert.equal(await c.chat('p',[]),'完整回复');assert.equal(requests,2);assert.equal(c.active,1)
    release();await rejection;assert.equal(c.active,0)
  })
  console.log(`${passed} cases passed`)
} finally {globalThis.fetch=originalFetch}
