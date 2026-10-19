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
 const run=async (e,options)=>handler.handle(e.evt,e.parsed,options)
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
  const result=await t.run(e);assert.match(result.text,/1分钟/);assert.match(result.text,/小黑屋/)
  assert.deepEqual(t.bans,[{g:G,id:B,s:60}]);assert.equal(t.calls.length,1)
  assert.equal(t.calls[0].options.maxTokens,1600);assert.ok(t.lookups.every(c=>c.options.noCache))
  await t.run(e);assert.equal(t.bans.length,1);assert.equal(t.calls.length,1)
 })
 await test('非群主不能冒用群主操作；消息sender.role伪造不生效',async()=>{
  const t=fixture();t.enable('owner-mute');const e=t.event(undefined,A);e.evt.sender={role:'owner'}
  assert.equal(await t.run(e),null);assert.equal(t.calls.length,0);assert.equal(t.bans.length,0)
 })
 await test('群员可主动申请禁言自己，目标强制绑定本人',async()=>{
  const t=fixture();t.enable('self-mute');const e=t.event('帮我禁言我自己十分钟',A);e.evt.message=[{type:'at',data:{qq:BOT}}]
  t.setAnswer(mute('self',A,'我自己','十分钟'));const r=await t.run(e)
  assert.deepEqual(t.bans,[{g:G,id:A,s:600}]);assert.match(r.text,/送你进小黑屋/)
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
 await test('英文缩写、混合单位与数学式经AI原文提取后执行真实秒数',async()=>{
  for(const [phrase,expected] of [['10s',10],['10 seconds',10],['2min',120],['1m30s',90],['1H',3600],['1d',86400],['00:01:30',90],['(2^3+2)min',600],['2**3s',8],['根号九分钟',180],['5!秒',120],['log2(1024)分钟',600],['2π分钟',377],['10ms',1]]){
   const t=fixture();t.enable('owner-mute');t.setAnswer(mute('mention',B,`[@${B}]`,phrase))
   const r=await t.run(t.event(`禁言 [@${B}]${phrase}`));assert.equal(t.bans[0]?.s,expected,phrase);assert.match(r.text,/小黑屋/)
  }
  for(const phrase of ['(31*24)h','30d+1s','2^30秒'])assert.equal(parseMuteDuration(phrase).overLimit,true,phrase)
  for(const phrase of ['(1/0)秒','sqrt(-1)秒','171!秒','process.exit()秒','10','1小时*2小时'])assert.ok(parseMuteDuration(phrase).error,phrase)
 })
 await test('AI不能截短英文或数学时长，零值不得误判成解禁',async()=>{
  for(const [text,answer] of [[`禁言 [@${B}]30d+1s`,mute('mention',B,`[@${B}]`,'30d')],[`禁言 [@${B}]10s+3`,mute('mention',B,`[@${B}]`,'10s')],[`禁言 [@${B}]0s`,{intent:'unmute',targets:[{type:'mention',value:B,source:`[@${B}]`}]}]]){
   const t=fixture();t.enable('owner-mute');let unbans=0;t.onebot.clearGroupBan=async()=>unbans++;t.setAnswer(answer);await t.run(t.event(text));assert.equal(t.bans.length,0);assert.equal(unbans,0)
  }
 })
 await test('引用选人只绑定本群被回复消息的作者，不采用引文里提到的人',async()=>{
  for(const sameGroup of [true,false]){
   const t=fixture();t.enable('owner-mute');const e=t.event('禁言10s');e.evt.message=[{type:'at',data:{qq:BOT}}]
   t.setAnswer({intent:'mute',targets:[{type:'reply',value:B,source:''}],durationText:'10s'})
   await t.run(e,{quotedRaw:{message_type:'group',group_id:sameGroup?G:G+1,message_id:99,user_id:B,raw_message:`别人的QQ ${A}`}})
   assert.equal(t.bans.length,sameGroup?1:0);if(sameGroup)assert.equal(t.bans[0].id,B)
  }
 })
 await test('上下文指代要求近期真实发言证据和高置信度，旧群/旧消息/含糊对象不猜',async()=>{
  for(const kind of ['valid','low','fake','other-group','clarify']){
   const t=fixture();t.enable('owner-mute');t.handler.observe({message_type:'group',group_id:kind==='other-group'?G+1:G,user_id:B,message_id:909,sender:{nickname:'群友'}},{text:'发了一个广告'})
   const e=t.event('把刚才发广告那个人禁言10s');e.evt.message=[{type:'at',data:{qq:BOT}}]
   t.setAnswer({intent:'mute',targets:[{type:'context',value:B,source:'刚才发广告那个人',evidenceMessageId:kind==='fake'?'wrong':'909'}],durationText:'10s',confidence:kind==='low'?.5:.99,needsClarification:kind==='clarify'})
   await t.run(e);assert.equal(t.bans.length,kind==='valid'?1:0,kind)
  }
 })
 await test('批量去重、单目标失败不阻断其他人，回执分别报告结果',async()=>{
  const t=fixture();t.enable('owner-mute');const e=t.event(`把 [@${A}] 和 [@${B}] 禁言10s`)
  e.evt.message=[{type:'at',data:{qq:BOT}},{type:'at',data:{qq:A}},{type:'at',data:{qq:B}}]
  t.setAnswer({intent:'mute',targets:[A,B,A].map(id=>({type:'mention',value:id,source:`[@${id}]`})),durationText:'10s'})
  let failed=0;t.onebot.setGroupBan=async(g,id,s)=>{if(id===A){failed++;throw Error('timeout')}t.bans.push({g,id,s})}
  const r=await t.run(e);assert.equal(failed,1);assert.deepEqual(t.bans,[{g:G,id:B,s:10}]);assert.match(r.text,/1位未能确认/);assert.match(r.text,/小黑屋/)
 })
 await test('批量目标有歧义不先处理部分目标，普通成员不能借批量扩展本人权限',async()=>{
  const t=fixture();t.enable('owner-mute');t.setAnswer({intent:'mute',targets:[{type:'mention',value:B,source:`[@${B}]`},{type:'name',value:'不存在',source:'不存在'}],durationText:'10s'})
  await t.run(t.event(`禁言 [@${B}] 和不存在10s`));assert.equal(t.bans.length,0)
  const s=fixture();s.enable('self-mute');s.setAnswer({intent:'mute',targets:[{type:'self',value:A,source:'我'},{type:'mention',value:B,source:`[@${B}]`}],durationText:'10s'})
  await s.run(s.event(`禁言我和 [@${B}]10s`,A));assert.equal(s.bans.length,0)
 })
 await test('全员禁言是原生开关，仅当前群主和指定群；不创建续期或频率规则',async()=>{
  for(const enable of [true,false]){
   const t=fixture();t.enable('whole-mute');const calls=[];t.onebot.setGroupWholeBan=async(g,v)=>calls.push({g,v})
   t.setAnswer({intent:enable?'whole_enable':'whole_disable',durationText:null});const e=t.event(enable?'开启全员禁言':'关闭全员禁言');e.evt.message=[{type:'at',data:{qq:BOT}}]
   const r=await t.run(e);assert.deepEqual(calls,[{g:G,v:enable}]);assert.match(r.text,/全员禁言/);assert.equal(t.bans.length,0)
   await t.run(t.event('开启全员禁言',A));await t.run(t.event('开启全员禁言',O,G+1));assert.equal(calls.length,1)
  }
 })
 await test('时段计划、带自动结束时长和模型误判都不能误开始终禁言',async()=>{
  for(const text of ['每天22:00到07:00开启全员禁言','开启全员禁言10s','今晚开启全员禁言','禁言指定成员']){
   const t=fixture();t.enable('whole-mute');let calls=0;t.onebot.setGroupWholeBan=async()=>calls++
   t.setAnswer({intent:'whole_enable',durationText:null});await t.run(t.event(text));assert.equal(calls,0,text)
  }
 })
 await test('解禁必须是显式群主请求；全员开关和个人解禁封装独立',async()=>{
  const t=fixture();t.enable('owner-mute');const unbans=[];t.onebot.clearGroupBan=async(g,id)=>unbans.push({g,id})
  t.setAnswer({intent:'unmute',targets:[{type:'mention',value:B,source:`[@${B}]`}]});await t.run(t.event(`解禁 [@${B}]`));assert.deepEqual(unbans,[{g:G,id:B}])
  const api=[],client=new OneBotClient({url:'ws://example.invalid',logger});client.api=async(a,p)=>api.push({a,p})
  await client.clearGroupBan(G,B);await client.setGroupWholeBan(G,true)
  assert.deepEqual(api,[{a:'set_group_ban',p:{group_id:G,user_id:Number(B),duration:0}},{a:'set_group_whole_ban',p:{group_id:G,enable:true}}])
  assert.throws(()=>client.setGroupWholeBan(G,'false'))
 })
 await test('重新连接清空上下文选人证据，不把登录前的旧话题当当前对象',async()=>{
  const t=fixture();t.enable('owner-mute');t.onebot.messageTimeline={session:1}
  t.handler.observe({message_type:'group',group_id:G,user_id:B,message_id:909},{text:'旧话题'})
  t.onebot.messageTimeline.session=2
  const e=t.event('禁言他10s');e.evt.message=[{type:'at',data:{qq:BOT}}]
  t.setAnswer({intent:'mute',targets:[{type:'context',value:B,source:'他',evidenceMessageId:'909'}],durationText:'10s',confidence:.99})
  await t.run(e);assert.equal(t.bans.length,0)
 })
 console.log(`${count} group-mute cases passed; no network or real group mutations.`)
}finally{for(const m of stores)if(m.timer)clearTimeout(m.timer);assert.equal(path.dirname(root),os.tmpdir());rmSync(root,{recursive:true,force:true})}
