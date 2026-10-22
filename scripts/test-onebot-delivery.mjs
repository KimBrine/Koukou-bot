import assert from 'node:assert/strict'
import {OneBotClient} from '../src/onebot.js'
import {healthAlertForError,isOnebotError} from '../src/onebotErrors.js'
const logger={info(){},warn(){}}
const alert=healthAlertForError('回复生成失败：OneBot API 超时：send_group_msg')
assert.equal(alert.key,'qq-delivery');assert.doesNotMatch(alert.text,/模型调用/);assert.match(alert.text,/未确认/)
assert.equal(healthAlertForError('总结模型 HTTP 429 quota').key,'model-health')
assert.equal(healthAlertForError('一般业务错误'),null)
assert.doesNotMatch(healthAlertForError('OneBot get_group_member_info 超时').text,/发送超时/)
const budget=new OneBotClient({url:'ws://test',logger}),timeouts=[]
budget.api=async(a,p,t)=>{timeouts.push(t);return {message_id:1}}
await budget.sendGroup(1,'a');await budget.sendPrivate(2,'b');await budget.sendGroup(1,'a',50)
assert.deepEqual(timeouts,[30000,30000,50])

const Original=globalThis.WebSocket
let socket,mode='numeric',sent=0
class FakeSocket extends EventTarget{
 static OPEN=1
 constructor(){super();socket=this;this.readyState=1;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
 send(raw){
  const packet=JSON.parse(raw)
  if(packet.action==='send_group_msg'){
   sent++
   if(mode==='timeout')return
   setTimeout(()=>this.message({echo:Number(packet.echo),status:'ok',data:{message_id:31}}),10)
  }else queueMicrotask(()=>this.message({echo:packet.echo,status:'ok',data:{user_id:9,nickname:'test'}}))
 }
 message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}))}
 close(){this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code:1000}))}
}
globalThis.WebSocket=FakeSocket
const ob=new OneBotClient({url:'ws://test',logger});ob.refreshStatus=async()=>({})
let running
try{
 const ready=new Promise(r=>ob.once('ready',r));running=ob.run();await ready
 assert.equal((await ob.sendGroup(1,'test',100)).message_id,31,'数字 echo 能配对字符串请求编号')
 mode='timeout'
 const pending=ob.sendGroup(1,'timeout',15)
 const echo=String(ob.echoSeq)
 await assert.rejects(pending,e=>isOnebotError(e)&&e.code==='ONEBOT_TIMEOUT'&&e.action==='send_group_msg'&&e.outcomeUnknown===true)
 socket.message({echo,status:'ok',data:{message_id:32}})
 assert.equal(ob.pending.size,0);assert.equal(sent,2,'超时和迟到回执都不再次发送')
 mode='numeric'
 const disconnected=ob.sendGroup(1,'disconnect',100);socket.close()
 await assert.rejects(disconnected,e=>e.code==='ONEBOT_DISCONNECTED'&&e.outcomeUnknown)
 await assert.rejects(ob.sendGroup(1,'offline'),e=>e.code==='ONEBOT_DISCONNECTED'&&!e.outcomeUnknown)
 console.log('OneBot delivery passed: 30s send budget, numeric echo, late receipts, disconnect, no retries and separate QQ/model alerts. Simulated socket only.')
}finally{ob.stop();await running;globalThis.WebSocket=Original}
