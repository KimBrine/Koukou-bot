// 全部接口与模型均为替身：不会真实禁言，也不调用付费 API。
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createGroupMute,parseMuteDuration,MAX_MUTE_SECONDS} from '../src/groupMute.js'
import {createCustomCommands} from '../src/customCommands.js'
import {createCommandCenter} from '../src/commandCenter.js'
import {OneBotClient} from '../src/onebot.js'
import {createBot} from '../src/bot.js'
import {MemoryStore} from '../src/memory.js'
const root=mkdtempSync(path.join(os.tmpdir(),'koukou-mute-')),stores=[]
const G=200000002,O='200000011',A='200000012',B='200000013',BOT='200000010'
const logger={info(){},warn(){},error(){},debug(){}}
let count=0,seq=0
const mute=(type='mention',target=B,source=`[@${B}]`,duration=null)=>({intent:'mute',targetType:type,target,targetText:source,durationText:duration})
function fixture(){
 const dir=path.join(root,String(++seq)),calls=[],bans=[],lookups=[],sent=[]
 let answer=mute(),live=true,actorRole='owner',targetRole='member',botRole='admin',hook=null
 const config={dataDir:dir,rootDir:dir,adminUsers:[],whitelistGroups:new Set([G]),mutedGroups:new Set(),autoPlusOneEnabled:false,quietHours:'',proactiveRate:0,contextRememberAll:false,replyMaxLines:1,replyLineMaxChars:80,replyLengthMatch:false,emojiKeepRate:0,humanDelayMinMs:0,humanDelayMaxMs:0}
 const customCommands=createCustomCommands({file:path.join(dir,'custom.json'),logger})
 const llm={async chat(prompt,messages,options){calls.push({prompt,messages,options});if(hook)await hook();return typeof answer==='string'?answer:JSON.stringify(answer)}}
 const commandCenter=createCommandCenter({file:path.join(dir,'center.json'),customCommands,config,logger,llm})
 const enable=id=>commandCenter.saveBuiltin({...commandCenter.get(id),enabled:true,scope:'group',groups:[G]})
 const onebot={selfId:BOT,async getGroupMemberInfo(g,id,timeout,options){lookups.push({g,id,options});return {user_id:id,role:String(id)===BOT?botRole:String(id)===O?actorRole:targetRole,nickname:'目标群友'}},async getGroupMemberList(){return [{user_id:B,card:'测试群友',nickname:'群友'}]},async setGroupBan(g,id,s){bans.push({g,id,s})},async sendGroup(g,text){sent.push(text);return {message_id:sent.length}}}
 const handler=createGroupMute({onebot,commandCenter,llm,logger,canExecute:()=>live})
 function event(text=`禁言 [@${B}]`,user=O,group=G,at=true){return {evt:{post_type:'message',message_type:'group',group_id:group,user_id:user,message_id:++seq,time:Date.now()/1000,message:[...(at?[{type:'at',data:{qq:BOT}}]:[]),{type:'at',data:{qq:B}}]},parsed:{text,atBot:at}}}
 const run=async e=>handler.handle(e.evt,e.parsed)
 return {dir,config,customCommands,llm,onebot,commandCenter,handler,calls,bans,lookups,sent,enable,event,run,setAnswer:a=>answer=a,setLive:v=>live=v,setActor:v=>actorRole=v,setTarget:v=>targetRole=v,setBot:v=>botRole=v,setHook:v=>hook=v}
}
async function test(name,fn){await fn();count++;console.log('PASS '+name)}
try{
 await test('默认关闭，无群号参考包导入后仍关闭，不能扩大成所有群',()=>{
  const t=fixture();assert.equal(t.commandCenter.enabled('owner-mute'),false)
  const file=readFileSync(new URL('../examples/group-mute.commands.json',import.meta.url),'utf8')
  t.commandCenter.importPack(file,{includeBuiltins:true});assert.equal(t.commandCenter.enabled('self-mute'),false)
  assert.throws(()=>t.commandCenter.saveBuiltin({...t.commandCenter.get('self-mute'),scope:'all',enabled:true}),/指定群/)
  assert.throws(()=>t.commandCenter.saveBuiltin({...t.commandCenter.get('self-mute'),enabled:true}),/至少选择/)
 })
 await test('群外、私聊、无@、旧消息不查询权限或调用解析API',async()=>{
  const t=fixture();t.enable('owner-mute');t.enable('self-mute')
  assert.equal(await t.run(t.event(undefined,O,G+1)),null)
  const p=t.event();p.evt.message_type='private';assert.equal(await t.run(p),null)
  assert.equal(await t.run(t.event(undefined,O,G,false)),null)
  t.setLive(false);assert.equal(await t.run(t.event()),null)
  assert.equal(t.calls.length,0);assert.equal(t.lookups.length,0);assert.equal(t.bans.length,0)
 })
 await test('AI解析群主请求，默认60秒，只调用一次动作，重报不重复禁言',async()=>{
  const t=fixture();t.enable('owner-mute');const e=t.event()
  const result=await t.run(e);assert.match(result.text,/默认/)
  assert.deepEqual(t.bans,[{g:G,id:B,s:60}]);assert.equal(t.calls.length,1)
  assert.equal(t.calls[0].options.maxTokens,500);assert.ok(t.lookups.every(c=>c.options.noCache))
  await t.run(e);assert.equal(t.bans.length,1);assert.equal(t.calls.length,1)
 })
 await test('非群主不能冒用群主操作；消息sender.role伪造不生效',async()=>{
  const t=fixture();t.enable('owner-mute');const e=t.event(undefined,A);e.evt.sender={role:'owner'}
  assert.equal(await t.run(e),null);assert.equal(t.calls.length,0);assert.equal(t.bans.length,0)
 })
 await test('群员可主动申请禁言自己，目标强制绑定本人',async()=>{
  const t=fixture();t.enable('self-mute');const e=t.event('帮我禁言我自己十分钟',A);e.evt.message=[{type:'at',data:{qq:BOT}}]
  t.setAnswer(mute('self',A,'我自己','十分钟'));const r=await t.run(e)
  assert.deepEqual(t.bans,[{g:G,id:A,s:600}]);assert.match(r.text,/已禁言你/)
 })
 await test('自助模式不执行A要求禁言B，模型返回他人或伪造self也无效',async()=>{
  for(const answer of [mute(),mute('self',B,'我'),mute('self',A,'我')]){
   const t=fixture();t.enable('self-mute');t.setAnswer(answer)
   await t.run(t.event(`我要求禁言 [@${B}]`,A));assert.equal(t.bans.length,0)
  }
 })
 await test('self仅对明确原文自指有效，不接受不存在或拼造目标',async()=>{
  const t=fixture();t.enable('self-mute');const e=t.event('禁言测试群友',A);e.evt.message=[{type:'at',data:{qq:BOT}}]
  t.setAnswer(mute('self',A,'自己'));await t.run(e);assert.equal(t.bans.length,0)
  t.setAnswer(mute('self',A,'测试群友'));await t.run({...e,evt:{...e.evt,message_id:++seq}});assert.equal(t.bans.length,0)
 })
 await test('群主可用唯一完整昵称；重名、其他群查不到或假@不执行',async()=>{
  const t=fixture();t.enable('owner-mute');t.setAnswer(mute('name','测试群友','测试群友','半小时'))
  const e=t.event('把测试群友关小黑屋半小时');e.evt.message=[{type:'at',data:{qq:BOT}}]
  await t.run(e);assert.equal(t.bans[0].s,1800)
  t.onebot.getGroupMemberList=async()=>[{user_id:A,card:'测试群友'},{user_id:B,card:'测试群友'}]
  await t.run({...e,evt:{...e.evt,message_id:++seq}});assert.equal(t.bans.length,1)
  t.setAnswer(mute());await t.run({...e,parsed:{...e.parsed,text:`禁言 [@${B}]`},evt:{...e.evt,message_id:++seq}});assert.equal(t.bans.length,1)
 })
 await test('三十天边界、复合/半数/中文数值；超限是玩笑不缩短执行',async()=>{
  for(const [phrase,expected] of [['三十天',MAX_MUTE_SECONDS],['一天两小时三分钟四秒',93784],['一个半小时',5400],['一小时半',5400],['一分半',90],['0.5分钟',30],['半分钟',30],['二十五分钟',1500],['1小时30分钟',5400]])assert.equal(parseMuteDuration(phrase).seconds,expected,phrase)
  for(const phrase of ['三十一天','30天零1秒','三十天又一秒','一年','一万天','永久'])assert.equal(parseMuteDuration(phrase).overLimit,true,phrase)
  for(const phrase of ['0分钟','负一分钟','-1分钟','五到十分钟','几分钟','两三分钟','一会儿','一个月'])assert.ok(parseMuteDuration(phrase).error,phrase)
  for(const id of ['owner-mute','self-mute']){
   const t=fixture();t.enable(id);const self=id==='self-mute',who=self?A:O
   const e=t.event(self?'禁言我31天':`禁言 [@${B}]31天`,who);if(self)e.evt.message=[{type:'at',data:{qq:BOT}}]
   t.setAnswer(mute(self?'self':'mention',self?A:B,self?'我':`[@${B}]`,'31天'))
   const r=await t.run(e);assert.match(r.text,/开玩笑/);assert.equal(t.bans.length,0)
  }
 })
 await test('AI不得漏掉、编造或截短时长，不把零/负值当成解禁',async()=>{
  for(const [text,phrase] of [[`禁言 [@${B}]100天`,null],[`禁言 [@${B}]30天零1秒`,'30天'],[`禁言 [@${B}]0分钟`,'0分钟'],[`禁言 [@${B}]`, '一分钟'],[`禁言 [@${B}]10`,null]]){
   const t=fixture();t.enable('owner-mute');t.setAnswer(mute('mention',B,`[@${B}]`,phrase));await t.run(t.event(text));assert.equal(t.bans.length,0,text)
  }
 })
 await test('权限不足、目标管理员/群主及权限变化，不执行动作',async()=>{
  for(const role of ['owner','admin','unknown']){const t=fixture();t.enable('owner-mute');t.setTarget(role);await t.run(t.event());assert.equal(t.bans.length,0)}
  const t=fixture();t.enable('owner-mute');t.setBot('member');await t.run(t.event());assert.equal(t.bans.length,0)
  const u=fixture();u.enable('owner-mute');u.setHook(()=>u.setActor('member'));await u.run(u.event());assert.equal(u.bans.length,0)
 })
 await test('AI返回none/非法JSON/超时、关闭中或请求过期均不落地禁言',async()=>{
  for(const answer of [{intent:'none'},'bad json']){const t=fixture();t.enable('owner-mute');t.setAnswer(answer);await t.run(t.event());assert.equal(t.bans.length,0)}
  for(const change of ['off','stale','timeout']){
   const t=fixture();t.enable('owner-mute');t.setHook(()=>{if(change==='off')t.commandCenter.saveBuiltin({...t.commandCenter.get('owner-mute'),enabled:false});if(change==='stale')t.setLive(false);if(change==='timeout')throw Error('timeout')})
   await t.run(t.event());assert.equal(t.bans.length,0)
  }
 })
 await test('QQ接口失败不伪报成功、不自动重试',async()=>{
  const t=fixture();t.enable('owner-mute');let requests=0;t.onebot.setGroupBan=async()=>{requests++;throw Error('timeout')}
  const e=t.event(),r=await t.run(e);assert.match(r.text,/未能确认/);await t.run(e);assert.equal(requests,1)
 })
 await test('OneBot封装使用秒、不缓存权限，并拒绝超限/零值',async()=>{
  const api=[],c=new OneBotClient({url:'ws://example.invalid',logger});c.api=async(a,p)=>{api.push({a,p})}
  await c.getGroupMemberInfo(G,O,8000,{noCache:true});assert.equal(api[0].p.no_cache,true)
  await c.setGroupBan(G,B,60);assert.deepEqual(api[1],{a:'set_group_ban',p:{group_id:G,user_id:Number(B),duration:60}})
  for(const n of [0,-1,30*86400+1,1.5,NaN])assert.throws(()=>c.setGroupBan(G,B,n))
 })
 await test('真实消息处理入口先执行新动作，不再生成第二份AI聊天回复；其他群保持普通对话',async()=>{
  const t=fixture();t.enable('owner-mute');t.enable('self-mute')
  const memory=new MemoryStore({file:path.join(t.dir,'memory.json'),limit:20,logger});stores.push(memory)
  const bot=createBot({...t,logger,memory,buildSystemPrompt:()=> '通用助手'})
  const event={post_type:'message',message_type:'group',group_id:G,user_id:O,message_id:++seq,time:Date.now()/1000,sender:{nickname:'群主'},message:[{type:'at',data:{qq:BOT}},{type:'text',data:{text:'禁言'}},{type:'at',data:{qq:B}}]}
  await bot.handleMessage(event);assert.equal(t.bans.length,1);assert.equal(t.calls.length,1);assert.equal(t.sent.length,1)
  t.setAnswer('普通对话');await bot.handleMessage({...event,group_id:G+1,message_id:++seq});assert.equal(t.bans.length,1);assert.equal(t.calls.length,2)
  assert.doesNotMatch(t.calls[1].prompt,/群管理请求解析器/)
 })
 console.log(`${count} group-mute cases passed; no network or real group mutations.`)
}finally{for(const m of stores)if(m.timer)clearTimeout(m.timer);assert.equal(path.dirname(root),os.tmpdir());rmSync(root,{recursive:true,force:true})}
