// 固定模拟时钟与QQ；任何fetch调用都会失败，不接入AI或真实QQ群。
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createQuietGreetings,greetingWindow} from '../src/quietGreetings.js'
import {createPersonaGreetingLibrary,personaGreetingHash} from '../src/personaGreetings.js'
import {createAdminServer} from '../src/admin/server.js'
import {OneBotClient} from '../src/onebot.js'
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('不得调用网络或AI')}
const logger={info(){},warn(){},error(){}}
const t=text=>Date.parse('2026-10-'+text+(text.split(':').length===3?'':':00')+'+08:00')
let passed=0
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
const dirs=[]
function setup(at=t('20T00:59:50'),options={}){
 const dir=mkdtempSync(path.join(os.tmpdir(),'quiet-greeting-'));dirs.push(dir)
 const x={at,online:true,sent:[],config:{dataDir:dir,rootDir:dir,envFile:path.join(dir,'.env'),quietGreetingsEnabled:true,quietHours:'01:00-07:00',whitelistGroups:new Set([101]),mutedGroups:new Set(),persona:'人格A',...options}}
 x.library=createPersonaGreetingLibrary({file:path.join(dir,'library.json'),logger});x.library.set('人格A',{goodmorning:['A早安一','A早安二','A早安三'],goodnight:['A晚安一，寂静时段到了','A晚安二，寂静时段到了','A晚安三，寂静时段到了']})
 x.onebot={status:()=>({online:x.online}),async sendGroup(group,message){x.sent.push({group,text:message[0].data.text,at:x.at});return {message_id:x.sent.length}}}
 x.create=()=>createQuietGreetings({config:x.config,library:x.library,onebot:x.onebot,logger,file:path.join(dir,'state.json'),now:()=>x.at,random:()=>0,sendGapMs:0,chatSettings:x.chatSettings})
 x.job=x.create();x.tick=async(text,online=x.online)=>{x.at=t(text);x.online=online;await x.job.tick()}
 return x
}
try{
 await test('北京时间与跨午夜时段准确，不受执行机器时区影响',()=>{
  assert.equal(greetingWindow('23:00-07:00',t('20T00:30')).quiet,true)
  assert.equal(greetingWindow('01:00-07:00',t('20T00:30')).quiet,false)
  assert.equal(greetingWindow('01:00-07:00',t('20T07:00')).quiet,false)
  assert.equal(greetingWindow('01:00-07:00',t('20T01:00')).start,t('20T01:00'))
  for(const spec of ['','07:00-07:00','25:00-07:00','01:99-07:00'])assert.equal(greetingWindow(spec,t('20T01:00')),null)
 })
 await test('初次启用不补昨天早安，晚安只在开始边界发送一次，持续在线结束后发早安',async()=>{
  const x=setup();await x.job.tick();assert.equal(x.sent.length,0)
  await x.tick('20T01:00');assert.equal(x.sent.length,1);assert.match(x.sent[0].text,/晚安/)
  await x.tick('20T01:01');await x.tick('20T06:59');assert.equal(x.sent.length,1)
  await x.tick('20T07:00');await x.tick('20T08:00');assert.equal(x.sent.length,2);assert.match(x.sent[1].text,/早安/)
 })
 await test('晚安没发，静谧期间登录不补；结束后迟到的首次登录仍发送早安',async()=>{
  const x=setup();await x.job.tick();await x.tick('20T01:00',false);await x.tick('20T03:00',true);assert.equal(x.sent.length,0)
  await x.tick('20T07:00',false);await x.tick('20T11:30',true);assert.equal(x.sent.length,1);assert.match(x.sent[0].text,/早安/)
  await x.tick('20T11:31',false);await x.tick('20T11:32',true);assert.equal(x.sent.length,1)
 })
 await test('夜里重启和结束后重启都不重复问候',async()=>{
  const x=setup();await x.job.tick();await x.tick('20T01:00');x.at=t('20T03:00');x.job=x.create();await x.job.tick();assert.equal(x.sent.length,1)
  await x.tick('20T07:00');x.job=x.create();await x.job.tick();assert.equal(x.sent.length,2)
 })
 await test('首次安装在安静时段里不发晚安，但结束后可以早安',async()=>{
  const x=setup(t('20T03:00'));await x.job.tick();assert.equal(x.sent.length,0);await x.tick('20T07:00');assert.equal(x.sent.length,1)
 })
 await test('刚好在开始时登录不发晚安，严重延迟的轮询也不补发',async()=>{
  const x=setup();x.online=false;await x.job.tick();await x.tick('20T01:00',true);assert.equal(x.sent.length,0)
  const y=setup();await y.job.tick();await y.tick('20T01:02');assert.equal(y.sent.length,0)
 })
 await test('两次轮询间发生重连或离线再登录，也不补晚安',async()=>{
  const x=setup();x.onebot.ws={};x.job=x.create();await x.job.tick();x.onebot.ws={};await x.tick('20T01:00');assert.equal(x.sent.length,0)
  const y=setup();y.onebot.accountStatusVersion=0;y.job=y.create();await y.job.tick();y.onebot.accountStatusVersion++;await y.tick('20T01:00');assert.equal(y.sent.length,0)
 })
 await test('用户可补发首次启用当天的未发早安，重复操作不重复，夜里不补',async()=>{
  const x=setup(t('20T12:00'));await x.job.tick();assert.equal(x.sent.length,0)
  const result=await x.job.catchUpMorning();assert.equal(result.sent,1);assert.match(x.sent[0].text,/早安/)
  assert.equal((await x.job.catchUpMorning()).sent,0);x.job=x.create();assert.equal((await x.job.catchUpMorning()).sent,0)
  const y=setup(t('20T03:00'));await y.job.tick();assert.equal((await y.job.catchUpMorning()).sent,0);assert.equal(y.sent.length,0)
 })
 await test('真实OneBot发送方法与消息段兼容，不依赖虚构的模拟接口',async()=>{
  const x=setup();x.onebot.sendGroup=OneBotClient.prototype.sendGroup
  x.onebot.api=async(action,params)=>{assert.equal(action,'send_group_msg');assert.equal(params.group_id,101);assert.equal(params.message[0].type,'text');x.sent.push(params);return {message_id:1}}
  await x.job.tick();await x.tick('20T01:00');assert.equal(x.sent.length,1)
 })
 await test('跨午夜、白天时段均按对应边界工作',async()=>{
  const x=setup(t('20T22:59:50'),{quietHours:'23:00-07:00'});await x.job.tick();await x.tick('20T23:00');await x.tick('21T07:00');assert.equal(x.sent.length,2)
  const y=setup(t('20T11:59:50'),{quietHours:'12:00-13:00'});await y.job.tick();await y.tick('20T12:00');await y.tick('20T13:00');assert.equal(y.sent.length,2)
 })
 await test('白名单、静音与总开关生效，群自定时段优先',async()=>{
  const x=setup(undefined,{whitelistGroups:new Set([101,102,103])});x.config.mutedGroups.add(102)
  x.chatSettings={resolve:key=>({enabled:key!=='g103',quietHours:'02:00-08:00'})};x.job=x.create();await x.job.tick()
  await x.tick('20T01:00');assert.equal(x.sent.length,0);await x.tick('20T01:59:55');await x.tick('20T02:00');assert.equal(x.sent.length,1);assert.equal(x.sent[0].group,101)
 })
 await test('缺少新人格语库不借用旧语库，添加新库后只用新库',async()=>{
  const x=setup();await x.job.tick();x.config.persona='人格B';await x.tick('20T01:00');assert.equal(x.sent.length,0)
  x.library.set('人格B',{goodmorning:['B早安'],goodnight:['B晚安']});await x.tick('20T07:00');assert.equal(x.sent[0].text,'B早安')
 })
 await test('群独立人格与全局人格不混用，排队时切换也不发旧人格',async()=>{
  const x=setup(undefined,{whitelistGroups:new Set([101,102])});const personaDir=path.join(x.config.dataDir,'personas')
  const {mkdirSync}=await import('node:fs');mkdirSync(personaDir);writeFileSync(path.join(personaDir,'B.txt'),'人格B')
  x.library.set('人格B',{goodmorning:['B早安'],goodnight:['B晚安']});x.chatSettings={resolve:key=>({persona:key==='g102'?'B':'',enabled:true})};x.job=x.create()
  await x.job.tick();await x.tick('20T01:00');assert.match(x.sent[0].text,/A晚安/);assert.equal(x.sent[1].text,'B晚安')
  const y=setup(undefined,{whitelistGroups:new Set([101,102])});await y.job.tick();const send=y.onebot.sendGroup;y.onebot.sendGroup=async(...args)=>{const r=await send(...args);y.config.persona='新人格';return r};await y.tick('20T01:00');assert.equal(y.sent.length,1)
 })
 await test('多日随机选择避开上一条，同类问候每天只一次',async()=>{
  const x=setup();await x.job.tick();await x.tick('20T01:00');await x.tick('20T07:00');await x.tick('21T00:59:55');await x.tick('21T01:00');await x.tick('21T07:00')
  assert.equal(x.sent.length,4);assert.notEqual(x.sent[0].text,x.sent[2].text);assert.notEqual(x.sent[1].text,x.sent[3].text)
 })
 await test('发送结果不明先落盘，不重登重试；单群失败不阻止其他群或早安',async()=>{
  const x=setup(undefined,{whitelistGroups:new Set([101,102])});await x.job.tick()
  const send=x.onebot.sendGroup;x.onebot.sendGroup=async(g,...args)=>{if(g===101)throw Error('send timeout');return send(g,...args)}
  await x.tick('20T01:00');assert.equal(x.sent.length,1);assert.equal(x.sent[0].group,102)
  x.onebot.sendGroup=send;x.job=x.create();await x.job.tick();assert.equal(x.sent.length,1)
  await x.tick('20T07:00');assert.equal(x.sent.length,3)
 })
 await test('白天改时段或临时加白名单不补历史问候，损坏状态暂停发送',async()=>{
  const x=setup(t('20T09:00'));await x.job.tick();x.config.quietHours='02:00-08:00';await x.tick('20T09:01');assert.equal(x.sent.length,0)
  writeFileSync(path.join(x.config.dataDir,'state.json'),'bad json');x.job=x.create();await x.tick('21T01:59:55');await x.tick('21T02:00');assert.equal(x.sent.length,0);assert.equal(x.job.status().blocked,true)
 })
 await test('每个人格语库独立持久化，迁移内容必须匹配人格，不能夹带CQ操作',()=>{
  const x=setup();const exported=x.library.exportFor('人格A');const other=setup();other.library.set('人格B',{goodmorning:[],goodnight:[]})
  assert.equal(other.library.get('人格B').goodmorning.length,0)
  assert.throws(()=>other.library.validateImport('人格B',exported),/不匹配/)
  other.library.set('人格A',other.library.validateImport('人格A',exported));assert.deepEqual(other.library.get('人格A'),x.library.get('人格A'))
  assert.throws(()=>other.library.set('人格A',{goodmorning:['[CQ:at,qq=all]'],goodnight:[]}),/CQ/)
  const reopened=createPersonaGreetingLibrary({file:path.join(other.config.dataDir,'library.json'),logger});assert.deepEqual(reopened.exportFor('人格A'),exported)
  assert.equal(exported.personaHash,personaGreetingHash('人格A'))
 })
 await test('控制台人格包导入导出携带对应语库，纯文本兼容保留，无群号和回执',async()=>{
  const x=setup();const admin=createAdminServer({config:x.config,personaGreetings:x.library,quietGreetings:x.job})
  try{
   const exported=await admin.actions['export-persona-package']({});const bundle=JSON.parse(exported.content)
   assert.equal(bundle.content,'人格A');assert.equal(bundle.greetings.goodmorning.length,3);assert.doesNotMatch(exported.content,/deliveries|whitelist|apiKey|groupId/)
   assert.equal((await admin.actions['export-persona']()).content,'人格A')
   const target=setup();const second=createAdminServer({config:target.config,personaGreetings:target.library})
   try{
    await second.actions['import-persona']({name:'迁移人格',content:bundle.content,greetings:bundle.greetings})
    assert.deepEqual(target.library.exportFor(bundle.content),bundle.greetings)
    await assert.rejects(second.actions['import-persona']({name:'错配人格',content:'不同人格',greetings:bundle.greetings}),/不匹配/)
    assert.equal(existsSync(path.join(target.config.dataDir,'personas','错配人格.txt')),false)
   }finally{second.server.close()}
  }finally{admin.server.close()}
 })
 console.log(`${passed} quiet-greeting cases passed; no network, QQ or AI calls.`)
}finally{globalThis.fetch=originalFetch;for(const dir of dirs){assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('quiet-greeting-'));rmSync(dir,{recursive:true,force:true})}}
