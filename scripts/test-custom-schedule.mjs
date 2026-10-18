import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCustomCommands } from '../src/customCommands.js'
import { createCustomCommandSchedule, verifyCustomDelivery } from '../src/customCommandSchedule.js'
import { MemoryStore } from '../src/memory.js'
const root=mkdtempSync(path.join(os.tmpdir(),'koukou-custom-schedule-'))
const logger={info(){},warn(){}}, memories=[]
let sequence=0,passed=0
async function test(name,run){await run();passed++;console.log('PASS '+name)}
function fixture(groups=[200000002]){
  const dir=path.join(root,String(++sequence));mkdirSync(dir)
  let clock=new Date('2026-10-18T09:00:00').getTime(),online=true
  const commands=createCustomCommands({file:path.join(dir,'commands.json'),logger})
  commands.upsert({name:'模拟定时',trigger:'不触发',reply:'模拟通知 {date}',scheduleEnabled:true,scheduleTimes:['09:00'],scheduleGroups:groups})
  const sent=[]
  const onebot={selfId:'200000010',async refreshStatus(){return {online,connected:online}},async sendGroup(g,text){sent.push({g,text});return {message_id:sent.length}}}
  const memory=new MemoryStore({file:path.join(dir,'memory.json'),limit:99,logger});memories.push(memory)
  const options={file:path.join(dir,'delivery.json'),commands,onebot,memory,logger,now:()=>clock}
  return {dir,commands,onebot,memory,sent,options,advance:ms=>clock+=ms,offline:()=>online=false,online:()=>online=true,now:()=>clock}
}
try{
  await test('成功回执持久化，同一分钟重复检查及重启都不重复发送',async()=>{
    const t=fixture(),a=createCustomCommandSchedule(t.options)
    await a.tick();await a.tick();assert.equal(t.sent.length,1)
    const b=createCustomCommandSchedule(t.options);await b.tick();assert.equal(t.sent.length,1)
    assert.equal(Object.values(b.status().deliveries)[0].status,'sent')
  })
  await test('离线不占发送名额，窗口内恢复补一次，超出五分钟不追补',async()=>{
    const t=fixture(),s=createCustomCommandSchedule(t.options);t.offline();await s.tick()
    assert.deepEqual(s.status().deliveries,{});t.advance(30000);t.online();await s.tick();assert.equal(t.sent.length,1)
    const late=fixture(),ls=createCustomCommandSchedule(late.options);late.offline();await ls.tick();late.advance(300000);late.online();await ls.tick()
    assert.equal(late.sent.length,0)
  })
  await test('明确未发出的失败保留重试；一个群失败不阻塞其他群',async()=>{
    const t=fixture([200000002,200000003]);let first=true,calls=[]
    t.onebot.sendGroup=async(g,text)=>{calls.push(g);if(g===200000002&&first){first=false;throw Error('OneBot 未连接')}return {message_id:calls.length}}
    const s=createCustomCommandSchedule(t.options);await s.tick();assert.equal(calls.length,2)
    t.advance(30000);await s.tick();assert.deepEqual(calls,[200000002,200000003,200000002])
    assert.ok(Object.values(s.status().deliveries).every(r=>r.status==='sent'))
  })
  await test('超时但历史确认已送达，只补送达记录，不重发',async()=>{
    const t=fixture();let calls=0,checks=0
    t.onebot.sendGroup=async()=>{calls++;throw Error('OneBot API 超时')}
    const s=createCustomCommandSchedule({...t.options,verify:async()=>{checks++;return {status:'present',messageId:'history-id'}}})
    await s.tick();t.advance(30000);await s.tick();assert.equal(calls,1);assert.equal(checks,1)
    assert.equal(Object.values(s.status().deliveries)[0].status,'sent')
  })
  await test('历史无法核实时不盲目重发；可核实未送达时最多尝试三次',async()=>{
    for(const proof of ['unknown','absent']){
      const t=fixture();let calls=0;t.onebot.sendGroup=async()=>{calls++;throw Error('网络超时')}
      const s=createCustomCommandSchedule({...t.options,verify:async()=>({status:proof})})
      for(let i=0;i<5;i++){await s.tick();t.advance(30000)}
      assert.equal(calls,proof==='unknown'?1:3)
    }
  })
  await test('生成中的发送记录跨重启先核验；已确认的记录不会重新占槽',async()=>{
    const t=fixture(),item=t.commands.due(t.now())[0]
    writeFileSync(t.options.file,JSON.stringify({version:1,deliveries:{[item.slotKey]:{status:'sending',attempts:1,attemptAt:t.now()-30000,targetAt:item.targetAt,groupId:item.groupId,selfId:t.onebot.selfId,text:'模拟通知',memoryBoundary:0}}}))
    const s=createCustomCommandSchedule({...t.options,verify:async()=>({status:'present',messageId:'prior-send'})})
    await s.tick();assert.equal(t.sent.length,0);assert.equal(Object.values(s.status().deliveries)[0].status,'sent')
  })
  await test('并发检查只有一次投递，发送结果出来前不标记为已送达',async()=>{
    const t=fixture();let release,entered
    const ready=new Promise(r=>entered=r);t.onebot.sendGroup=async()=>{entered();return new Promise(r=>release=r)}
    const s=createCustomCommandSchedule(t.options),task=s.tick();await ready
    assert.equal(Object.values(s.status().deliveries)[0].status,'sending');assert.equal(await s.tick(),false)
    release({message_id:9});await task;assert.equal(Object.values(s.status().deliveries)[0].status,'sent')
  })
  await test('记录损坏或发送前无法落盘均不发送，避免重启后无法去重',async()=>{
    const bad=fixture();writeFileSync(bad.options.file,'not json');const a=createCustomCommandSchedule(bad.options)
    await a.tick();assert.equal(a.status().blocked,true);assert.equal(bad.sent.length,0)
    const fail=fixture(),b=createCustomCommandSchedule(fail.options);mkdirSync(fail.options.file)
    await b.tick();assert.equal(fail.sent.length,0)
  })
  await test('清理发生在发送等待期间，回执不会把旧内容重新写入记忆',async()=>{
    const t=fixture();t.onebot.sendGroup=async()=>{t.memory.clearKey('g200000002');return {message_id:1}}
    await createCustomCommandSchedule(t.options).tick();assert.equal(t.memory.count('g200000002'),0)
  })
  await test('限流不提前标记已送达，额度恢复后窗口内可以发送',async()=>{
    const t=fixture();let allowed=false
    const s=createCustomCommandSchedule({...t.options,rateLimiter:{check:()=>({allowed}),record(){}}})
    await s.tick();assert.equal(t.sent.length,0);allowed=true;t.advance(30000);await s.tick();assert.equal(t.sent.length,1)
  })
  await test('历史核验区分已发、完整未发、分页不全及读取失败',async()=>{
    const t=fixture(),at=t.now(),entry={groupId:200000002,selfId:t.onebot.selfId,text:'模拟通知',attemptAt:at}
    const msg=(id,time,user_id,text)=>({message_id:id,time:time/1000,user_id,message:[{type:'text',data:{text}}]})
    const previous=msg('1',at-3000,200000011,'之前的发言'),next=msg('3',at+1000,200000011,'后续发言')
    const onebot={async getGroupMsgHistory(){return {messages:[previous,msg('2',at,t.onebot.selfId,'模拟通知'),next]}}}
    assert.equal((await verifyCustomDelivery(onebot,entry)).status,'present')
    onebot.getGroupMsgHistory=async()=>({messages:[previous,next]});assert.equal((await verifyCustomDelivery(onebot,entry)).status,'absent')
    onebot.getGroupMsgHistory=async()=>({messages:[next]});assert.equal((await verifyCustomDelivery(onebot,entry)).status,'unknown')
    onebot.getGroupMsgHistory=async()=>{throw Error('读取失败')};assert.equal((await verifyCustomDelivery(onebot,entry)).status,'unknown')
  })
  await test('实际账号改变时不以新账号重试旧账号的待核验投递',async()=>{
    const t=fixture();t.onebot.sendGroup=async()=>{throw Error('超时')}
    const s=createCustomCommandSchedule({...t.options,verify:async()=>({status:'absent'})});await s.tick()
    t.onebot.selfId='200000099';t.onebot.sendGroup=async()=>{throw Error('不该调用')}
    t.advance(30000);await s.tick();assert.equal(Object.values(s.status().deliveries)[0].attempts,1)
  })
  console.log(`${passed} cases passed`)
}finally{
  for(const m of memories){if(m.timer)clearTimeout(m.timer);m.flush()}
  assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('koukou-custom-schedule-'));rmSync(root,{recursive:true,force:true})
}
