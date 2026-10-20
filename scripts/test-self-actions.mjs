// 全部 QQ 和模型接口使用替身，不删除真实消息、不拍真人、不调用付费模型。
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createSelfActions} from '../src/selfActions.js'
import {createCommandCenter} from '../src/commandCenter.js'
import {createCustomCommands} from '../src/customCommands.js'
import {createBot} from '../src/bot.js'
import {MemoryStore} from '../src/memory.js'
import {OneBotClient} from '../src/onebot.js'
const root=mkdtempSync(path.join(os.tmpdir(),'koukou-self-actions-')),stores=[]
const G=200000002,U=200000011,V=200000012,BOT='200000010'
const logger={info(){},warn(){},error(){},debug(){}}
let seq=1,passed=0
const result=(intent='recall_self',selfSource='我')=>({intent,selfSource,confidence:.99})
function fixture(){
 const dir=path.join(root,String(++seq)),calls=[],removed=[],pokes=[],sent=[],reads=[]
 let answer=result(),reply='拍到你啦～',onParse=null,live=true,clock=Date.now(),botRole='admin',actorRole='member'
 const config={dataDir:dir,rootDir:dir,persona:'通用人格',adminUsers:[],whitelistGroups:new Set([G]),mutedGroups:new Set(),quietHours:'',proactiveRate:0,autoPlusOneEnabled:false,contextRememberAll:false,humanDelayMinMs:0,humanDelayMaxMs:0,replyMaxLines:1,replyLineMaxChars:80,emojiKeepRate:0}
 const llm={async chat(prompt,messages,options){calls.push({prompt,messages,options});if(prompt.startsWith('你只识别')){if(onParse)await onParse();return typeof answer==='string'?answer:JSON.stringify(answer)}if(reply instanceof Error)throw reply;return reply}}
 const customCommands=createCustomCommands({file:path.join(dir,'custom.json'),logger})
 const commandCenter=createCommandCenter({file:path.join(dir,'center.json'),customCommands,config,llm,logger})
 const onebot={selfId:BOT,messageTimeline:{session:1,isCurrent:()=>live},async getMsg(id){reads.push(id);return {message_type:'group',group_id:G,message_id:id,user_id:U,message:'本人原消息'}},async getGroupMemberInfo(g,id,timeout,options){assert.equal(options?.noCache,true);return {user_id:id,role:String(id)===BOT?botRole:String(id)===String(U)?actorRole:'member'}},async deleteMessage(id){removed.push(id)},async pokeGroupMember(g,id){pokes.push({g,id})},async sendGroup(g,text){sent.push(text);return {message_id:++seq}}}
 const actions=createSelfActions({onebot,commandCenter,llm,logger,config,canExecute:()=>live,now:()=>clock})
 function event(text='帮我撤回',quote='101',user=U,group=G,at=true){return {evt:{post_type:'message',message_type:'group',message_id:++seq,group_id:group,user_id:user,time:Date.now()/1000,sender:{nickname:'群友甲'},message:[...(at?[{type:'at',data:{qq:BOT}}]:[]),...(quote?[{type:'reply',data:{id:quote}}]:[]),{type:'text',data:{text}}]},parsed:{text,replyId:quote,atBot:at}}}
 function enable(id){return commandCenter.saveBuiltin({...commandCenter.get(id),enabled:true,scope:'group',groups:[G]})}
 const run=(e,options)=>actions.handle(e.evt,e.parsed,options)
 const reserve=e=>actions.reserveFollowup(e.evt)
 return {dir,config,llm,customCommands,commandCenter,onebot,actions,event,enable,run,reserve,calls,removed,pokes,sent,reads,setAnswer:v=>answer=v,setReply:v=>reply=v,setHook:v=>onParse=v,setLive:v=>live=v,setBot:v=>botRole=v,setActor:v=>actorRole=v,advance:n=>clock+=n}
}
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
async function question(t){t.enable('self-recall');const e=t.event('帮我撤回',null);t.reserve(e);const r=await t.run(e);assert.ok(r.clarification);assert.equal(t.actions.arm(e.evt,r),true);return e}
try{
 await test('公开版本默认关闭，指定群配置、额外权限和导入导出保留',()=>{
  const t=fixture();assert.equal(t.commandCenter.enabled('self-recall'),false);assert.equal(t.commandCenter.enabled('request-poke'),false)
  assert.throws(()=>t.commandCenter.saveBuiltin({id:'self-recall',scope:'all',enabled:true}),/指定群/)
  t.enable('self-recall');const pack=t.commandCenter.exportPack({id:'self-recall'});assert.deepEqual(pack.builtins[0].groups,[])
  const other=fixture();other.commandCenter.importPack(JSON.stringify(pack),{includeBuiltins:true});assert.equal(other.commandCenter.enabled('self-recall'),false)
  t.commandCenter.saveBuiltin({...t.commandCenter.get('self-recall'),adminOnly:true});assert.equal(t.commandCenter.allows('self-recall',{groupId:G,userId:U,isPrivate:false}),true,'撤回本人消息始终允许普通成员，不能额外锁为管理员')
 })
 await test('群外、私聊、无@、旧消息和自身消息不进入动作解析',async()=>{
  const t=fixture();t.enable('self-recall')
  for(const e of [t.event(undefined,'101',U,G+1),t.event(undefined,'101',U,G,false),t.event(undefined,'101',BOT)])assert.equal(await t.run(e),null)
  const e=t.event();e.evt.message_type='private';assert.equal(await t.run(e),null)
  t.setLive(false);assert.equal(await t.run(t.event()),null);assert.equal(t.calls.length,0);assert.equal(t.reads.length,0)
 })
 await test('引用本人原消息并@，核验原群作者和编号后仅撤回一次',async()=>{
  const t=fixture();t.enable('self-recall');const e=t.event();const r=await t.run(e)
  assert.deepEqual(t.removed,['101']);assert.match(r.text,/收回啦/);await t.run(e);assert.equal(t.removed.length,1)
  assert.equal(t.calls.length,1);assert.equal(t.calls[0].options.temperature,0)
 })
 await test('他人、跨群、缺群号、缺编号、错编号和私聊不能冒充待撤回原消息',async()=>{
  for(const patch of [{user_id:V},{group_id:G+1},{group_id:undefined},{message_id:undefined},{message_id:'999'},{message_type:'private'}]){
   const t=fixture();t.enable('self-recall');const get=t.onebot.getMsg;t.onebot.getMsg=async id=>({...await get(id),...patch})
   const r=await t.run(t.event());assert.equal(t.removed.length,0);assert.match(r.text,/没有通过核对/)
  }
 })
 await test('无管理权限或QQ撤回拒绝、超时均明确说明，不伪称成功或自动重试',async()=>{
  const t=fixture();t.enable('self-recall');t.setBot('member');assert.match((await t.run(t.event())).text,/管理权限/);assert.equal(t.removed.length,0)
  const u=fixture();u.enable('self-recall');let count=0;u.onebot.deleteMessage=async()=>{count++;throw Error('timeout')}
  assert.match((await u.run(u.event())).text,/没能确认撤回成功/);await u.run(u.event());assert.equal(count,1)
 })
 await test('缺少引用时发问；仅同群同人的第一条无@补充能接上',async()=>{
  const t=fixture();await question(t)
  assert.equal(t.reserve(t.event('这条','102',V,G,false)),null);assert.equal(t.reserve(t.event('这条','102',U,G+1,false)),null)
  const e=t.event('这条','102',U,G,false),token=t.reserve(e);assert.ok(token)
  await t.run(e,{followup:token});assert.deepEqual(t.removed,['102']);assert.equal(t.reserve(t.event('再来','103',U,G,false)),null)
 })
 await test('第一条无引用、无关、取消或另起拍一拍均结束，不等待第二条',async()=>{
  for(const kind of ['unrelated','cancel','no-quote','new-action']){
   const t=fixture();await question(t);const e=t.event(kind==='cancel'?'不撤了':'顺便问问',kind==='no-quote'?null:'102',U,G,false),token=t.reserve(e)
   t.setAnswer(kind==='new-action'?result('poke_self'):result('none'))
   assert.match((await t.run(e,{followup:token})).text,/结束/);assert.equal(t.removed.length,0);assert.equal(t.pokes.length,0)
   assert.equal(t.reserve(t.event('这条','103',U,G,false)),null)
  }
 })
 await test('追问尚未送达或发送后用户已讲新话，迟到问题不挂起旧请求',async()=>{
  const t=fixture();t.enable('self-recall');const e=t.event('帮我撤回',null);t.reserve(e);const r=await t.run(e)
  assert.equal(t.reserve(t.event('这条','101',U,G,false)),null);assert.equal(t.actions.arm(e.evt,r),false)
  assert.equal(t.removed.length,0)
 })
 await test('超时、重连和设置变更使等待失效；重复请求不占补充次数',async()=>{
  for(const kind of ['timeout','session','settings']){
   const t=fixture();await question(t)
   if(kind==='timeout')t.advance(120001);if(kind==='session')t.onebot.messageTimeline.session++;if(kind==='settings')t.commandCenter.saveBuiltin({...t.commandCenter.get('self-recall'),enabled:false})
   assert.equal(t.reserve(t.event('这条','101',U,G,false)),null)
  }
  const t=fixture(),e=await question(t);assert.equal(t.reserve(e),null);assert.ok(t.reserve(t.event('这条','101',U,G,false)))
 })
 await test('首次补充同步消费，紧邻第二条不能替代第一条的引用',async()=>{
  const t=fixture();await question(t);const first=t.event('这条','101',U,G,false),second=t.event('这条','102',U,G,false)
  const token=t.reserve(first);assert.ok(token);assert.equal(t.reserve(second),null)
  await t.run(first,{followup:token});assert.deepEqual(t.removed,['101'])
 })
 await test('两个并发请求同一条消息只提交一次撤回',async()=>{
  const t=fixture();t.enable('self-recall');await Promise.all([t.run(t.event()),t.run(t.event())]);assert.equal(t.removed.length,1)
 })
 await test('解析中关闭指令、断线或人格过期，不执行原生动作',async()=>{
  for(const kind of ['off','stale','persona','reconnect']){
   const t=fixture();t.enable('self-recall');t.setHook(()=>kind==='off'?t.commandCenter.saveBuiltin({...t.commandCenter.get('self-recall'),enabled:false}):kind==='stale'?t.setLive(false):kind==='reconnect'?t.onebot.messageTimeline.session++:null)
   await t.run(t.event(),{canReply:()=>kind!=='persona'});assert.equal(t.removed.length,0)
  }
 })
 await test('不理解、低置信度、非法JSON或解析超时不执行',async()=>{
  for(const answer of [result('none'),{...result(),confidence:.5},'bad json']){const t=fixture();t.enable('self-recall');t.setAnswer(answer);await t.run(t.event());assert.equal(t.removed.length,0)}
  const t=fixture();t.enable('self-recall');t.setHook(()=>{throw Error('timeout')});assert.match((await t.run(t.event())).text,/不执行/);assert.equal(t.removed.length,0)
 })
 await test('主动拍请求者本人成功后才生成一句AI回复，参数不接受模型指定目标',async()=>{
  const t=fixture();t.enable('request-poke');t.setAnswer({...result('poke_self'),target:V});t.setReply('拍一拍肩膀，今天也辛苦啦～')
  const r=await t.run(t.event('拍一拍我',null));assert.deepEqual(t.pokes,[{g:G,id:U}]);assert.equal(t.calls.length,2);assert.equal(r.text,'拍一拍肩膀，今天也辛苦啦～')
  assert.match(t.calls[1].prompt,/已成功拍一拍/)
 })
 await test('忽略无动作与伪造自指词；明确第三人@可拍',async()=>{
  for(const kind of ['none','missing-self','other-at']){
   const t=fixture();t.enable('request-poke');t.setAnswer(result(kind==='none'?'none':'poke_self',kind==='missing-self'?'自己':'我'))
   const e=t.event('我说拍他',null);if(kind==='other-at')e.evt.message.push({type:'at',data:{qq:V}})
   const r=await t.run(e);assert.equal(t.pokes.length,kind==='other-at'?1:0)
  }
 })
 await test('QQ拍一拍失败时不生成成功话语，已拍后AI失败只回简短回执',async()=>{
  const t=fixture();t.enable('request-poke');t.setAnswer(result('poke_self'));t.onebot.pokeGroupMember=async()=>{throw Error('rate limit')}
  assert.match((await t.run(t.event('拍我',null))).text,/没能确认成功/);assert.equal(t.calls.length,1)
  const u=fixture();u.enable('request-poke');u.setAnswer(result('poke_self'));u.setReply(Error('model timeout'))
  assert.match((await u.run(u.event('拍我',null))).text,/拍到你啦/);assert.equal(u.pokes.length,1);assert.equal(u.calls.length,2)
 })
 await test('拍一拍回复清理内部标签、合并换行、限制长度；生成时关闭不继续回复',async()=>{
  const t=fixture();t.enable('request-poke');t.setAnswer(result('poke_self'));t.setReply('拍到你啦\n'+ '好'.repeat(300))
  const r=await t.run(t.event('拍我',null));assert.ok(r.text.length<=160);assert.doesNotMatch(r.text,/\n/)
  const u=fixture();u.enable('request-poke');u.setAnswer(result('poke_self'));u.onebot.pokeGroupMember=async()=>{u.pokes.push(1);u.commandCenter.saveBuiltin({...u.commandCenter.get('request-poke'),enabled:false})}
  assert.equal((await u.run(u.event('拍我',null))).text,undefined);assert.equal(u.pokes.length,1);assert.equal(u.calls.length,1)
 })
 await test('OneBot原生封装使用delete_msg和send_poke，拒绝无效编号',async()=>{
  const client=Object.create(OneBotClient.prototype),calls=[];client.api=async(a,p)=>{calls.push({a,p})}
  await client.deleteMessage('-123');await client.pokeGroupMember(G,U)
  assert.deepEqual(calls,[{a:'delete_msg',p:{message_id:-123}},{a:'send_poke',p:{group_id:G,user_id:U}}])
  for(const id of [0,'bad',NaN,'9007199254740992'])assert.throws(()=>client.deleteMessage(id))
  assert.throws(()=>client.pokeGroupMember(G,'all'))
 })
 await test('真实消息入口衔接无@引用补充，不重复调用普通聊天模型',async()=>{
  const t=fixture();t.enable('self-recall');const memory=new MemoryStore({file:path.join(t.dir,'memory.json'),limit:20,logger});stores.push(memory)
  const bot=createBot({...t,logger,memory,buildSystemPrompt:()=> '当前人格'}),first=t.event('帮我撤回',null)
  await bot.handleMessage(first.evt);assert.equal(t.sent.length,1);assert.match(t.sent[0],/下一条消息/)
  await bot.handleMessage(t.event('','101',U,G,false).evt);assert.equal(t.sent.length,2);assert.deepEqual(t.removed,['101']);assert.equal(t.calls.length,2)
 })
 await test('真实入口拍真人后只回复一句，自己的拍一拍通知不形成循环',async()=>{
  const t=fixture();t.enable('request-poke');t.setAnswer(result('poke_self'));const memory=new MemoryStore({file:path.join(t.dir,'memory.json'),limit:20,logger});stores.push(memory)
  const bot=createBot({...t,logger,memory,buildSystemPrompt:()=> '当前人格'})
  await bot.handleMessage(t.event('拍我',null).evt);assert.equal(t.sent.length,1);assert.equal(t.pokes.length,1);assert.equal(t.calls.length,2)
  await bot.handleNotice({notice_type:'notify',sub_type:'poke',group_id:G,user_id:BOT,target_id:U});assert.equal(t.calls.length,2);assert.equal(t.sent.length,1)
 })
 await test('撤回他人：仅群主或同时是群管理员的机器人管理员，实时核验身份',async()=>{
  for(const [role,configured,allowed] of [['owner',false,true],['admin',true,true],['admin',false,false],['member',true,false],['member',false,false]]){
   const t=fixture();t.enable('self-recall');t.setActor(role);t.config.adminUsers=configured?[String(U)]:[]
   const get=t.onebot.getMsg;t.onebot.getMsg=async id=>({...await get(id),user_id:V})
   await t.run(t.event('把这条撤回'))
   assert.equal(t.removed.length,allowed?1:0,role+' '+configured)
  }
  const t=fixture();t.enable('self-recall');t.setActor('admin');t.config.adminUsers=[String(U)]
  t.onebot.getMsg=async id=>({message_type:'group',group_id:G,message_id:id,user_id:V})
  t.setHook(()=>t.setActor('member'));await t.run(t.event());assert.equal(t.removed.length,0,'解析期间失去群权限不能撤回他人')
 })
 await test('群主也不能引用跨群、伪造编号或私聊消息撤回；机器人无管理权限不能操作',async()=>{
  for(const patch of [{group_id:G+1},{message_id:'bad'},{message_type:'private'}]){
   const t=fixture();t.enable('self-recall');t.setActor('owner');t.onebot.getMsg=async id=>({message_type:'group',group_id:G,message_id:id,user_id:V,...patch})
   await t.run(t.event());assert.equal(t.removed.length,0)
  }
  const t=fixture();t.enable('self-recall');t.setActor('owner');t.setBot('member');t.onebot.getMsg=async id=>({message_type:'group',group_id:G,message_id:id,user_id:V})
  await t.run(t.event());assert.equal(t.removed.length,0)
 })
 await test('所有成员均可请求拍第三人，但仅白名单；修改管理员限制和群范围不能绕过',async()=>{
  const t=fixture();t.enable('request-poke');t.commandCenter.saveBuiltin({...t.commandCenter.get('request-poke'),adminOnly:true,scope:'all',groups:[G+1]})
  t.setAnswer({...result('poke'),confidence:.7});const e=t.event('帮我拍拍这位',null);e.evt.message.push({type:'at',data:{qq:V}})
  await t.run(e);assert.deepEqual(t.pokes,[{g:G,id:V}]);assert.equal(JSON.parse(t.calls[1].messages[0].content).target.userId,String(V))
  assert.equal(await t.run(t.event('拍拍我',null,U,G+1)),null)
  const u=fixture();u.enable('request-poke');u.setAnswer(result('poke_self'));u.setHook(()=>u.config.whitelistGroups.delete(G))
  await u.run(u.event('拍我',null));assert.equal(u.pokes.length,0,'识别后移出白名单也不执行')
 })
 await test('拍人可用引用、近期发言与唯一昵称，模型杜撰号码不能直接执行',async()=>{
  const t=fixture();t.enable('request-poke');t.setAnswer({...result('poke'),target:{type:'reply'}})
  t.onebot.getMsg=async id=>({message_type:'group',group_id:G,message_id:id,user_id:V})
  await t.run(t.event('拍拍这位'));assert.deepEqual(t.pokes,[{g:G,id:V}])
  const u=fixture();u.enable('request-poke');u.setAnswer({...result('poke'),target:{type:'context',value:String(V)}})
  const before=u.event('我刚说的',null,V);u.actions.observe(before.evt,before.parsed)
  await u.run(u.event('拍拍他',null));assert.deepEqual(u.pokes,[{g:G,id:V}])
  const n=fixture();n.enable('request-poke');n.setAnswer({...result('poke'),target:{type:'name',value:'甜甜'}})
  n.onebot.getGroupMemberList=async()=>[{user_id:V,card:'甜甜圈'}]
  await n.run(n.event('拍拍甜甜',null));assert.deepEqual(n.pokes,[{g:G,id:V}])
  const bad=fixture();bad.enable('request-poke');bad.setAnswer({...result('poke'),target:{type:'context',value:'99999'}})
  assert.ok((await bad.run(bad.event('帮忙拍拍',null))).clarification);assert.equal(bad.pokes.length,0)
 })
 await test('拍人目标不明时只接同群同人下一条补充，无需再次@，不与撤回等待混用',async()=>{
  const t=fixture();t.enable('request-poke');t.setAnswer(result('poke'))
  const first=t.event('帮忙拍拍',null);t.reserve(first);const ask=await t.run(first);assert.equal(t.actions.arm(first.evt,ask),true)
  const next=t.event('这位',null,U,G,false);next.evt.message.push({type:'at',data:{qq:V}})
  const followup=t.reserve(next);assert.equal(followup.intent,'poke')
  await t.run(next,{followup});assert.deepEqual(t.pokes,[{g:G,id:V}]);assert.equal(t.removed.length,0)
  assert.equal(JSON.parse(t.calls[1].messages[0].content).awaitingPoke,true)
  assert.equal(t.reserve(t.event('还有这位',null,U,G,false)),null)
 })
 console.log(`${passed} self-action cases passed; no real QQ actions or paid model calls.`)
}finally{for(const m of stores)if(m.timer)clearTimeout(m.timer);assert.equal(path.dirname(root),os.tmpdir());rmSync(root,{recursive:true,force:true})}
