import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WebSocket } from 'ws'
import { createOfficialBridge, PROTOCOL } from '../bridge.mjs'
import { parseArguments } from '../cli.mjs'

const TOKEN='fixture-loopback-token-'.repeat(3)
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII='
const wait=()=>new Promise(resolve=>setImmediate(resolve))
async function cleanup(root) {
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('koukou-official-'))
  await fs.rm(root,{recursive:true,force:true})
}
class FakeSDK extends EventEmitter {
  constructor(){super();this.calls=[];this.stopped=false;this.next=0}
  async start(){this.emit('ready')}
  stop(){this.stopped=true}
  async sendText(target,text){this.calls.push(['text',target,text]);if(this.failure)throw this.failure;return {id:'sent-'+(++this.next)}}
  async sendImage(target,source){this.calls.push(['image',target,source]);if(this.failure)throw this.failure;return {message:{id:'sent-'+(++this.next)}}}
  async recallMessage(target,id){this.calls.push(['recall',target,id]);if(this.recallFailure)throw this.recallFailure}
  incoming(overrides={}) {const message={kind:'group',rawEventType:'GROUP_AT_MESSAGE_CREATE',senderId:'member-one',groupOpenid:'group-one',
    content:'fixture question',messageId:'incoming-one',timestamp:'2026-01-01T00:00:00Z',...overrides};this.emit('message',{message},message)}
}
async function fixture(t,{bound=false,enableQQ=false,...options}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'koukou-official-'))
  const stateDir=path.join(root,'private-state'),credentialsFile=path.join(root,'credentials.json')
  if(bound)await fs.writeFile(credentialsFile,JSON.stringify({protocol:PROTOCOL,version:1,appId:'app-fixture',appSecret:'private-fixture-secret'}))
  const sdk=new FakeSDK(),factoryOptions=[]
  const bridge=await createOfficialBridge({token:TOKEN,stateDir,credentialsFile,port:0,enableQQ,
    sdkFactory:config=>{factoryOptions.push(config);return sdk},...options})
  await bridge.start()
  t.after(async()=>{await bridge.close();await cleanup(root)})
  return {root,stateDir,credentialsFile,sdk,bridge,factoryOptions}
}
const request=(action,params={},echo='echo-one')=>({action,params,echo})
function sendParams(overrides={}) {return {scope:'group',targetId:'group-one',msgId:'incoming-one',segments:[{type:'text',text:'fixture reply'}],...overrides}}
async function socket(bridge,headers={}) {
  const client=new WebSocket(`ws://127.0.0.1:${bridge.server.address().port}/`,{headers:{Authorization:'Bearer '+TOKEN,...headers}})
  const first=once(client,'message');await once(client,'open')
  return {client,initial:JSON.parse((await first)[0].toString())}
}

test('default is an authenticated loopback-only offline bridge with no SDK or QR side effects',async t=>{
  let qrCalls=0
  const {bridge,factoryOptions}=await fixture(t,{connectorStart:()=>{qrCalls++;throw Error('must not call')}})
  assert.equal(bridge.server.address().address,'127.0.0.1')
  const {client,initial}=await socket(bridge);t.after(()=>client.terminate())
  assert.equal(initial.type,'qq-status');assert.equal(initial.data.protocol,PROTOCOL);assert.equal(initial.data.binding.phase,'unbound')
  assert.equal(initial.data.capabilities.proactive,false);assert.equal(initial.data.capabilities.file,false)
  const received=once(client,'message');client.send(JSON.stringify(request('qq.status')))
  assert.equal(JSON.parse((await received)[0].toString()).status,'ok')
  assert.equal((await bridge.dispatch(request('qq.binding.start'))).code,'QQ_DISABLED')
  assert.equal((await bridge.dispatch(request('set_group_ban'))).code,'UNSUPPORTED_ACTION')
  assert.equal(qrCalls,0);assert.equal(factoryOptions.length,0)
})

test('upgrade rejects missing/wrong bearer, external Origin, hostile Host and query credentials',async t=>{
  const {bridge}=await fixture(t)
  for(const [headers,suffix] of [[{Authorization:''},'/'],[{Authorization:'Bearer wrong'},'/'],
    [{Origin:'https://untrusted.invalid'},'/'],[{Host:'untrusted.invalid'},'/'],[{},'/?token='+TOKEN]]) {
    const client=new WebSocket(`ws://127.0.0.1:${bridge.server.address().port}${suffix}`,{headers:{Authorization:'Bearer '+TOKEN,...headers}})
    client.on('error',()=>{})
    const response=await new Promise((resolve,reject)=>{client.once('unexpected-response',(_req,res)=>{res.resume();client.terminate();resolve(res.statusCode)})
      client.once('open',()=>{client.terminate();reject(Error('unexpectedly authorized'))})})
    assert.ok([401,403].includes(response))
  }
})

test('known credentials stay bound without enabling QQ; CLI defaults to no QQ',async t=>{
  const {bridge,factoryOptions}=await fixture(t,{bound:true})
  assert.equal(bridge.status().binding.phase,'bound');assert.equal(bridge.status().online,false)
  assert.equal(factoryOptions.length,0)
  assert.equal(parseArguments(['--state-dir','D:/private/state','--credentials-file','D:/private/credentials.json']).enableQQ,false)
  assert.throws(()=>parseArguments(['--host','0.0.0.0']))
  assert.throws(()=>parseArguments(['--state-dir','D:/x','--credentials-file','D:/y','--port','80']))
})

test('forwards structured SDK events and sends exactly one plain-text call with durable replay protection',async t=>{
  const {bridge,sdk,stateDir,factoryOptions}=await fixture(t,{bound:true,enableQQ:true})
  assert.equal(bridge.status().binding.phase,'online');assert.equal(factoryOptions[0].markdownSupport,false)
  const {client}=await socket(bridge);t.after(()=>client.terminate())
  const received=once(client,'message')
  sdk.incoming({attachments:[{content_type:'image/png',url:'https://example.invalid/image.png'}],mentions:[{member_openid:'member-two'}]})
  const event=JSON.parse((await received)[0].toString());assert.equal(event.type,'qq-message');assert.equal(event.data.rawEventType,'GROUP_AT_MESSAGE_CREATE')
  assert.equal(event.appId,'app-fixture');assert.equal(event.data.attachments.length,1)
  const body=request('qq.send',sendParams())
  const first=await bridge.dispatch(body),again=await bridge.dispatch(body)
  assert.deepEqual(first,again);assert.equal(first.data.messageId,'sent-1');assert.equal(sdk.calls.length,1)
  assert.deepEqual(sdk.calls[0],['text',{scope:'group',targetId:'group-one',msgId:'incoming-one'},'fixture reply'])
  assert.equal((await bridge.dispatch({...body,params:sendParams({segments:[{type:'text',text:'different'}]})})).code,'ECHO_REUSED')
  const ledger=JSON.parse(await fs.readFile(path.join(stateDir,'own-messages.json'),'utf8'))
  assert.equal(Object.values(ledger.sent)[0].state,'confirmed')
  assert.equal(JSON.stringify(bridge.status()).includes('private-fixture-secret'),false)
})

test('requires a known passive target, enforces four attempts, and does not partially send mixed or invalid images',async t=>{
  let time=100000
  const {bridge,sdk}=await fixture(t,{bound:true,enableQQ:true,now:()=>time})
  sdk.incoming()
  assert.equal((await bridge.dispatch(request('qq.send',sendParams({msgId:undefined}),'none'))).code,'PASSIVE_REPLY_REQUIRED')
  assert.equal((await bridge.dispatch(request('qq.send',sendParams({targetId:'other-group'}),'foreign'))).code,'PASSIVE_REPLY_EXPIRED')
  assert.equal((await bridge.dispatch(request('qq.send',sendParams({segments:[{type:'text',text:'hello'},{type:'image',base64:PNG,mime:'image/png'}]}),'mixed'))).code,'UNSUPPORTED_SEGMENTS')
  assert.equal((await bridge.dispatch(request('qq.send',sendParams({segments:[{type:'image',base64:PNG,mime:'image/jpeg'}]}),'bad-image'))).code,'INVALID_IMAGE')
  assert.equal(sdk.calls.length,0)
  for(let index=0;index<4;index++)assert.equal((await bridge.dispatch(request('qq.send',sendParams(),'send-'+index))).status,'ok')
  assert.equal((await bridge.dispatch(request('qq.send',sendParams(),'send-five'))).code,'PASSIVE_REPLY_EXPIRED')
  assert.equal(sdk.calls.length,4)
  sdk.incoming({messageId:'incoming-two'});time+=5*60*1000
  assert.equal((await bridge.dispatch(request('qq.send',sendParams({msgId:'incoming-two'}),'expired'))).code,'PASSIVE_REPLY_EXPIRED')
})

test('single image is binary memory only and requires a concrete SDK receipt',async t=>{
  const {bridge,sdk}=await fixture(t,{bound:true,enableQQ:true});sdk.incoming()
  const reply=await bridge.dispatch(request('qq.send',sendParams({segments:[{type:'image',base64:PNG,mime:'image/png'}]})))
  assert.equal(reply.data.messageId,'sent-1');assert.equal(sdk.calls[0][0],'image');assert.ok(Buffer.isBuffer(sdk.calls[0][2].buffer))
  assert.equal((await bridge.dispatch(request('qq.send',sendParams({segments:[{type:'image',localPath:'D:/private/file.png',mime:'image/png'}]}),'path'))).code,'INVALID_IMAGE')
  sdk.sendText=async()=>{sdk.calls.push(['missing-receipt']);return {}}
  const missing=await bridge.dispatch(request('qq.send',sendParams(),'missing'))
  assert.equal(missing.code,'MISSING_RECEIPT');assert.equal(missing.outcomeUnknown,true)
})

test('only exact app/scope/target confirmed own IDs can be recalled, including durable history after restart',async t=>{
  const {bridge,sdk,stateDir,credentialsFile}=await fixture(t,{bound:true,enableQQ:true});sdk.incoming()
  await bridge.dispatch(request('qq.send',sendParams()))
  assert.equal((await bridge.dispatch(request('qq.recall',{scope:'group',targetId:'group-one',messageId:'someone-else'},'not-own'))).code,'NOT_OWN_MESSAGE')
  assert.equal((await bridge.dispatch(request('qq.recall',{scope:'group',targetId:'other-group',messageId:'sent-1'},'foreign'))).code,'NOT_OWN_MESSAGE')
  await bridge.close()
  const sdk2=new FakeSDK()
  const restarted=await createOfficialBridge({token:TOKEN,stateDir,credentialsFile,port:0,enableQQ:true,sdkFactory:()=>sdk2});await restarted.start();t.after(()=>restarted.close())
  const body=request('qq.recall',{scope:'group',targetId:'group-one',messageId:'sent-1'},'recall')
  const result=await restarted.dispatch(body)
  assert.equal(result.status,'ok');assert.equal(result.data.recalled,true)
  assert.deepEqual(await restarted.dispatch(body),result)
  assert.equal(sdk2.calls.length,1)
  assert.equal((await restarted.dispatch({...body,echo:'second-recall'})).code,'NOT_OWN_MESSAGE')
  await restarted.close()
})

test('unknown send/recall is never replayed and does not leak SDK error details',async t=>{
  const {bridge,sdk}=await fixture(t,{bound:true,enableQQ:true});sdk.incoming()
  sdk.failure=Error('private-fixture-secret network timeout')
  const body=request('qq.send',sendParams())
  const failed=await bridge.dispatch(body)
  assert.equal(failed.outcomeUnknown,true);assert.equal(JSON.stringify(failed).includes('private-fixture-secret'),false)
  assert.deepEqual(await bridge.dispatch(body),failed);assert.equal(sdk.calls.length,1)
  sdk.failure=null
  const sent=await bridge.dispatch(request('qq.send',sendParams(),'confirmed'))
  sdk.recallFailure=Error('network timeout')
  const recall={scope:'group',targetId:'group-one',messageId:sent.data.messageId}
  assert.equal((await bridge.dispatch(request('qq.recall',recall,'recall'))).outcomeUnknown,true)
  assert.equal((await bridge.dispatch(request('qq.recall',recall,'new-recall'))).code,'NOT_OWN_MESSAGE')
  assert.equal(sdk.calls.filter(call=>call[0]==='recall').length,1)
})

test('QR binding is explicitly enabled, cancel discards stale callbacks, and successful credentials remain private',async t=>{
  let callbacks,canceled=0
  const {bridge,credentialsFile,factoryOptions}=await fixture(t,{enableQQ:true,
    connectorStart:(value,options)=>{callbacks=value;assert.equal(options.displayQrCodeToConsole,false);assert.equal(options.source,undefined);return()=>canceled++},
    renderQR:async()=>`data:image/png;base64,${PNG}`})
  await bridge.dispatch(request('qq.binding.start'))
  await callbacks.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture-binding')
  assert.equal(bridge.status().binding.phase,'qr');assert.ok(bridge.status().binding.qrDataUrl.startsWith('data:image/png;base64,'))
  await bridge.dispatch(request('qq.binding.cancel',{},'cancel'))
  await callbacks.onSuccess([{appId:'stale-app',appSecret:'stale-private-secret'}])
  await assert.rejects(fs.stat(credentialsFile),{code:'ENOENT'});assert.equal(bridge.status().binding.phase,'canceled')
  await bridge.dispatch(request('qq.binding.start',{},'restart-binding'))
  await callbacks.onSuccess([{appId:'new-app',appSecret:'new-private-secret',userOpenid:'owner-private-openid'}])
  assert.equal(bridge.status().appId,'new-app');assert.equal(bridge.status().online,true)
  assert.equal(factoryOptions.length,1);assert.equal(canceled,2)
  const publicStatus=JSON.stringify(bridge.status());assert.equal(publicStatus.includes('new-private-secret'),false);assert.equal(publicStatus.includes('owner-private-openid'),false)
  assert.equal(JSON.parse(await fs.readFile(credentialsFile,'utf8')).appSecret,'new-private-secret')
})

test('manual QR regeneration cancels the old task, removes the old image and ignores its callbacks',async t=>{
  const tasks=[]
  const {bridge,credentialsFile}=await fixture(t,{enableQQ:true,now:()=>1000000,
    connectorStart:callbacks=>{const task={callbacks,canceled:false};tasks.push(task);return()=>{task.canceled=true}},
    renderQR:async()=>`data:image/png;base64,${PNG}`})
  await bridge.dispatch(request('qq.binding.start'))
  await tasks[0].callbacks.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=first')
  assert.equal(bridge.status().binding.issuedAt,1000000)
  assert.equal(bridge.status().binding.refreshAt,1120000)
  await bridge.dispatch(request('qq.binding.start'))
  assert.equal(tasks[0].canceled,true);assert.equal(tasks.length,2)
  assert.equal(bridge.status().binding.phase,'preparing')
  assert.equal(bridge.status().binding.qrDataUrl,undefined)
  await tasks[0].callbacks.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=stale')
  await tasks[0].callbacks.onSuccess([{appId:'stale',appSecret:'stale-private-secret'}])
  assert.equal(bridge.status().binding.phase,'preparing')
  await assert.rejects(fs.stat(credentialsFile),{code:'ENOENT'})
  await tasks[1].callbacks.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=second')
  assert.match(bridge.status().binding.qrUrl,/task_id=second$/)
})

test('expiry and local renewal invalidate slow renderers; preparation timeout clears stale QR',async t=>{
  const tasks=[],timers=new Set(),renders=[]
  const {bridge}=await fixture(t,{enableQQ:true,
    qrTimers:{setTimeout:(fn,delay)=>{const timer={fn,delay};timers.add(timer);return timer},clearTimeout:timer=>timers.delete(timer)},
    connectorStart:callbacks=>{tasks.push(callbacks);return()=>{}},
    renderQR:()=>new Promise(resolve=>renders.push(resolve))})
  await bridge.dispatch(request('qq.binding.start'))
  const first=tasks[0].onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=old')
  tasks[0].onQrExpired()
  const second=tasks[0].onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=fresh')
  renders[1](`data:image/png;base64,${PNG}`);await second
  renders[0](`data:image/png;base64,${PNG}`);await first
  assert.match(bridge.status().binding.qrUrl,/task_id=fresh$/)
  const renewal=[...timers].find(timer=>timer.delay===120000)
  assert.ok(renewal);renewal.fn();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(tasks.length,2);assert.equal(bridge.status().binding.phase,'preparing')
  assert.equal(bridge.status().binding.qrDataUrl,undefined)
  const timeout=[...timers].find(timer=>timer.delay===30000)
  timeout.fn()
  assert.equal(bridge.status().binding.phase,'error');assert.match(bridge.status().binding.message,/超时/)
  assert.equal(bridge.status().binding.qrUrl,undefined)
  assert.equal(timers.size,0)
})

test('connector failures and unsupported QR URLs are recoverable without publishing SDK secrets',async t=>{
  let callback,throws=true
  const {bridge}=await fixture(t,{enableQQ:true,
    connectorStart:value=>{if(throws)throw Error('secret credential');callback=value;return()=>{}},
    renderQR:async()=>`data:image/png;base64,${PNG}`})
  await bridge.dispatch(request('qq.binding.start'))
  assert.equal(bridge.status().binding.phase,'error')
  assert.doesNotMatch(JSON.stringify(bridge.status()),/secret credential/)
  throws=false;await bridge.dispatch(request('qq.binding.start'))
  await callback.onQrDisplayed('https://evil.invalid/qqbot/openclaw/connect.html?task_id=foreign')
  assert.equal(bridge.status().binding.phase,'error');assert.equal(bridge.status().binding.qrUrl,undefined)
  await bridge.dispatch(request('qq.binding.start'))
  await callback.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=valid')
  callback.onFailure(Error('task secret'))
  assert.equal(bridge.status().binding.phase,'error');assert.equal(bridge.status().binding.qrDataUrl,undefined)
  assert.doesNotMatch(JSON.stringify(bridge.status()),/task secret/)
})

test('rejects production data, unknown files, corrupted own ledger and concurrent use without overwriting',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'koukou-official-paths-'));t.after(()=>cleanup(root))
  const state=path.join(root,'existing');await fs.mkdir(state);const memory=path.join(state,'memory.json');await fs.writeFile(memory,'{"fixture":true}')
  await assert.rejects(createOfficialBridge({token:TOKEN,stateDir:state,credentialsFile:path.join(root,'credentials.json')}),/不能复用/)
  assert.equal(await fs.readFile(memory,'utf8'),'{"fixture":true}')
  const other=path.join(root,'other');await fs.mkdir(other);await fs.writeFile(path.join(other,'keep.txt'),'keep')
  await assert.rejects(createOfficialBridge({token:TOKEN,stateDir:other,credentialsFile:path.join(root,'credentials.json')}),/独立/)
  const {bridge,stateDir,credentialsFile}=await fixture(t)
  await assert.rejects(createOfficialBridge({token:TOKEN,stateDir,credentialsFile}),/实例锁/)
  await bridge.close()
  await fs.writeFile(path.join(stateDir,'own-messages.json'),'[]')
  await assert.rejects(createOfficialBridge({token:TOKEN,stateDir,credentialsFile}),/状态损坏/)
})

test('disconnection updates status and invalidates sending until SDK ready again',async t=>{
  const {bridge,sdk}=await fixture(t,{bound:true,enableQQ:true});sdk.incoming()
  sdk.emit('disconnected',{willReconnect:true});assert.equal(bridge.status().binding.phase,'connecting');assert.equal(bridge.status().online,false)
  assert.equal((await bridge.dispatch(request('qq.send',sendParams()))).code,'QQ_OFFLINE');assert.equal(sdk.calls.length,0)
  sdk.emit('ready');assert.equal(bridge.status().online,true)
  await wait()
})

test('failed durable receipt reports unknown and blocks further operations rather than confirming a memory-only result',async t=>{
  const {bridge,sdk,stateDir}=await fixture(t,{bound:true,enableQQ:true});sdk.incoming()
  const ledger=path.join(stateDir,'own-messages.json')
  sdk.sendText=async()=>{
    sdk.calls.push(['text'])
    await fs.rename(ledger,ledger+'.preserved')
    await fs.mkdir(ledger)
    return {id:'confirmed-by-sdk'}
  }
  const body=request('qq.send',sendParams())
  const result=await bridge.dispatch(body)
  assert.equal(result.status,'failed');assert.equal(result.code,'STATE_WRITE_FAILED');assert.equal(result.outcomeUnknown,true)
  assert.equal((await bridge.dispatch(body)).code,'STATE_UNAVAILABLE')
  assert.equal(sdk.calls.length,1);assert.equal(bridge.status().online,false)
})

test('binding preserves an unrelated credentials file created after the bridge started',async t=>{
  let callbacks
  const {bridge,credentialsFile,factoryOptions}=await fixture(t,{enableQQ:true,connectorStart:value=>{callbacks=value;return()=>{}},renderQR:async()=>`data:image/png;base64,${PNG}`})
  await bridge.dispatch(request('qq.binding.start'))
  await fs.writeFile(credentialsFile,'preserve unrelated contents')
  await callbacks.onSuccess([{appId:'new-app',appSecret:'new-private-secret'}])
  assert.equal(await fs.readFile(credentialsFile,'utf8'),'preserve unrelated contents')
  assert.equal(factoryOptions.length,0);assert.equal(bridge.status().binding.phase,'error')
})
