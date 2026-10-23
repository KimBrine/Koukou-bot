import assert from 'node:assert/strict'
import { readUiSource } from './ui-source.mjs'
import { readFileSync } from 'node:fs'
import { OneBotClient } from '../src/onebot.js'
const logger={info(){},warn(){}}
let passed=0
async function test(name,task){await task();console.log(`PASS ${name}`);passed++}
const probeUserId='200000007'
const goodReply=action=>action==='get_stranger_info'?{user_id:Number(probeUserId),nickname:'核验账号'}:{online:true,good:true}
function client(){const ob=new OneBotClient({url:'ws://127.0.0.1:3002',logger,probeUserId,offlineGraceMs:0});ob.ws={readyState:WebSocket.OPEN};return ob}
await test('端口 / WebSocket 连接存在且保留昵称，QQ 离线仍显示离线',async()=>{
  const ob=client();ob.nickname='旧昵称';ob.selfId='200000010';ob.api=async()=>({online:false,good:true})
  const state=await ob.refreshStatus()
  assert.equal(state.connected,true);assert.equal(state.online,false);assert.equal(state.qqOnline,false)
})
await test('确认在线后掉线，下次核对必须变为离线',async()=>{
  const ob=client();ob.api=async action=>goodReply(action)
  assert.equal((await ob.refreshStatus()).online,true)
  ob.api=async()=>({online:false,good:true})
  assert.equal((await ob.refreshStatus({maxAgeMs:0})).online,false)
})
await test('超时或无效响应清除原来的绿色在线状态',async()=>{
  const ob=client();ob.updateAccountStatus({online:true,good:true})
  ob.api=async()=>{throw Error('timeout')}
  assert.equal((await ob.refreshStatus({maxAgeMs:0})).qqOnline,null)
  ob.api=async()=>({online:'true'})
  assert.equal((await ob.refreshStatus({maxAgeMs:0})).online,false)
})
await test('过期数据、服务异常与连接断开都不能显示在线',async()=>{
  const ob=client();ob.updateAccountStatus({online:true,good:true});ob.statusCheckedAt=Date.now()-16000
  assert.equal(ob.status().qqOnline,null)
  ob.updateAccountStatus({online:true,good:false});assert.equal(ob.status().online,false)
  ob.ws=null;assert.equal(ob.status().online,false);assert.equal(ob.status().connected,false)
})
await test('多个界面同时核对只请求一次',async()=>{
  const ob=client();let calls=0
  ob.api=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {online:false,good:true}}
  const result=await Promise.all([ob.refreshStatus(),ob.refreshStatus()])
  assert.equal(calls,1);assert.ok(result.every(s=>s.qqOnline===false))
})
await test('旧连接的迟到回包不能改变新连接状态',async()=>{
  const ob=client();let complete
  ob.api=()=>new Promise(r=>{complete=r})
  const pending=ob.refreshStatus();ob.ws={readyState:WebSocket.OPEN};complete({online:true,good:true})
  await pending;assert.equal(ob.status().online,false)
})
await test('收到离线心跳与 bot_offline 通知立即更新状态',async()=>{
  const OriginalWebSocket=globalThis.WebSocket
  let socket
  class FakeSocket extends EventTarget {
    static OPEN=1
    constructor(){super();socket=this;this.readyState=1;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
    send(text){const packet=JSON.parse(text);queueMicrotask(()=>this.message({echo:packet.echo,status:'ok',data:packet.action==='get_login_info'?{user_id:200000010,nickname:'测试'}:goodReply(packet.action)}))}
    message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}))}
    close(){this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code:1000}))}
  }
  globalThis.WebSocket=FakeSocket
  const ob=new OneBotClient({url:'ws://test',logger,probeUserId})
  try {
    const ready=new Promise(r=>ob.once('ready',r));const running=ob.run();await ready
    assert.equal((await ob.refreshStatus({maxAgeMs:0})).online,true)
    socket.message({post_type:'meta_event',meta_event_type:'heartbeat',status:{online:false,good:true}})
    assert.equal(ob.status().qqOnline,false)
    ob.updateAccountStatus({online:true,good:true})
    socket.message({post_type:'notice',notice_type:'bot_offline'})
    assert.equal(ob.status().qqOnline,false)
    ob.stop();await running
  }finally{ob.stop();globalThis.WebSocket=OriginalWebSocket}
})
await test('NapCat 一直报告在线，真实 QQ 请求超时仍不能亮绿灯',async()=>{
  const ob=client();ob.api=async action=>{if(action==='get_stranger_info')throw Error('timeout');return {online:true,good:true}}
  const state=await ob.refreshStatus()
  assert.equal(state.reportedOnline,true);assert.equal(state.qqOnline,null);assert.equal(state.online,false)
  assert.match(state.statusError,/实际连接未确认/)
  ob.updateAccountStatus({online:true,good:true})
  assert.equal(ob.status().online,false,'旧心跳不能覆盖核验失败')
})
await test('核验失败只按间隔重试，恢复后自动在线，资料必须来自正确账号',async()=>{
  const ob=client();let probes=0
  ob.api=async action=>{if(action==='get_status')return {online:true,good:true};probes++;return {user_id:999,nickname:'错账号'}}
  assert.equal((await ob.refreshStatus()).online,false)
  await ob.refreshStatus({maxAgeMs:0});assert.equal(probes,1)
  ob.probeCheckedAt=Date.now()-31000;ob.api=async action=>goodReply(action)
  assert.equal((await ob.refreshStatus({maxAgeMs:0})).online,true)
  ob.probeCheckedAt=Date.now()-46000;ob.updateAccountStatus({online:true,good:true})
  assert.equal(ob.status().online,false,'新心跳不能替代已过期的实际核验')
})
await test('核验过程中收到掉线通知，迟到的成功回包不能恢复在线',async()=>{
  const ob=client();let complete
  ob.api=async action=>action==='get_status'?{online:true,good:true}:new Promise(r=>{complete=r})
  const pending=ob.refreshStatus();await Promise.resolve()
  ob.updateAccountStatus({online:false,good:true});complete(goodReply('get_stranger_info'))
  await pending;assert.equal(ob.status().qqOnline,false)
})
await test('状态查询中收到离线事件，过时的 get_status 在线回包被忽略',async()=>{
  const ob=client();let complete
  ob.api=()=>new Promise(r=>{complete=r})
  const pending=ob.refreshStatus();ob.updateAccountStatus({online:false,good:true});complete({online:true,good:true})
  await pending;assert.equal(ob.status().qqOnline,false)
})
await test('控制台文案区分缓存在线、实际异常与成功核验',async()=>{
  const html = readUiSource()
  const source=html.match(/function accountStatusText\(b = \{\}\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(source)
  const label=new Function(`${source};return accountStatusText`)()
  assert.match(label({online:false,onebotConnected:true,reportedOnline:true,statusError:'QQ 实际连接未确认'}),/连接异常/)
  assert.match(label({online:false,onebotConnected:true,reportedOnline:true}),/核验中/)
  assert.equal(label({online:true}),'机器人在线')
  assert.equal(label({qqOnline:false}),'QQ 已离线')
})
await test('定时总结强制实时核验，不接受最近一次的缓存成功', async () => {
  const ob=client();let probes=0;let broken=false
  ob.api=async action=>{if(action==='get_stranger_info'){probes++;if(broken)throw Error('QQ offline')};return goodReply(action)}
  assert.equal((await ob.refreshStatus()).online,true);assert.equal(probes,1)
  broken=true
  assert.equal((await ob.refreshStatus({maxAgeMs:0})).online,true);assert.equal(probes,1)
  assert.equal((await ob.refreshStatus({maxAgeMs:0,forceProbe:true})).online,false);assert.equal(probes,2)
})
await test('强制核验遇到正在查询的普通状态，等待后仍执行实际核验',async()=>{
  const ob=client();ob.api=async action=>goodReply(action);await ob.refreshStatus()
  let complete;let probes=0;let hold=true
  ob.api=async action=>{if(action==='get_status'&&hold)return new Promise(r=>{complete=r});if(action==='get_stranger_info')probes++;return goodReply(action)}
  const normal=ob.refreshStatus({maxAgeMs:0});const forced=ob.refreshStatus({maxAgeMs:0,forceProbe:true})
  hold=false;complete({online:true,good:true});await Promise.all([normal,forced]);assert.equal(probes,1)
})
console.log(`${passed} cases passed`)
