// 临时规则、模拟模型与 QQ 接口；不调用付费服务，不向真实群聊发送消息。
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import {createCustomCommands} from '../src/customCommands.js'
import {createCommandCenter} from '../src/commandCenter.js'
import {createBot} from '../src/bot.js'
import {MemoryStore} from '../src/memory.js'
import {createChatSettings} from '../src/chatSettings.js'
import {createAdminServer} from '../src/admin/server.js'
const root=mkdtempSync(path.join(os.tmpdir(),'koukou-command-center-')),stores=[]
const logger={info(){},warn(){},debug(){},error(){}}
let seq=0,passed=0
async function test(name,run){await run();passed++;console.log('PASS '+name)}
function fixture(){
  const dir=path.join(root,String(++seq)),calls=[],sent=[],triggers=[],repeated=[]
  let result='AI回复',clock=Date.now()
  const llm={async chat(prompt,messages,options){calls.push({prompt,messages,options});return typeof result==='function'?result(prompt,messages):result}}
  const config={dataDir:dir,rootDir:dir,personaDir:path.join(dir,'personas'),persona:'示例人格',botName:'测试助手',adminUsers:[],pokeEnabled:true,pokeCooldownMs:0,
    autoPlusOneEnabled:true,idCheckEnabled:true,idCheckKickEnabled:false,idCheckGroups:[200000002],idCheckOperators:['200000011'],
    whitelistGroups:new Set([200000002,200000003]),mutedGroups:new Set(),quietHours:'',proactiveRate:0,contextRememberAll:false,replyMaxLines:1,replyLineMaxChars:40,replyLengthMatch:false,emojiKeepRate:0,humanDelayMinMs:0,humanDelayMaxMs:0,lineGapMinMs:0,lineGapMaxMs:0}
  const customCommands=createCustomCommands({file:path.join(dir,'custom.json'),logger})
  const commandCenter=createCommandCenter({file:path.join(dir,'center.json'),customCommands,config,logger,llm,now:()=>clock})
  const memory=new MemoryStore({file:path.join(dir,'memory.json'),limit:20,logger});stores.push(memory)
  const chatSettings=createChatSettings({file:path.join(dir,'chats.json'),logger})
  const onebot={selfId:'200000010',async sendGroup(groupId,text){sent.push({groupId,text});return {message_id:sent.length+100}},async sendPrivate(userId,text){sent.push({userId,text});return {message_id:sent.length+100}},async repeatGroupMessage(g,id){repeated.push({g,id})},async getGroupMemberInfo(){return {nickname:'群友'}}}
  const dailySummary={capture(){},summaryGroups(){return [200000002]},isRunning(){return false},countCaptured(){return 0},trigger(groups,options){triggers.push({groups,options})}}
  const bot=createBot({config,logger,llm,onebot,customCommands,commandCenter,memory,chatSettings,buildSystemPrompt:()=>config.persona,dailySummary,pokeReplier:()=> '原有私有拍一拍语料'})
  const ctx={isPrivate:false,groupId:200000002,userId:'200000011',direct:true,event:'message',name:'群友'}
  return {dir,config,calls,sent,triggers,repeated,llm,customCommands,commandCenter,memory,chatSettings,onebot,bot,ctx,setResult:r=>result=r,advance:n=>clock+=n}
}
let messageId=1000
const evt=(text,groupId=200000002,userId=200000011,direct=true)=>({post_type:'message',message_type:'group',group_id:groupId,user_id:userId,message_id:messageId++,time:Date.now()/1000,sender:{nickname:'测试群友'},message:[...(direct?[{type:'at',data:{qq:'200000010'}}]:[]),{type:'text',data:{text}}]})
try{
 await test('已有功能默认继承原配置，清理记忆保留显式管理员门槛',()=>{
  const t=fixture(),c=t.commandCenter;assert.equal(c.all().length,9)
  assert.equal(c.allows('summary',t.ctx),true);assert.equal(c.allows('clear-memory',t.ctx),false)
  c.saveBuiltin({...c.get('clear-memory'),adminOnly:false,naturalLanguage:true});assert.equal(c.get('clear-memory').adminOnly,true);assert.equal(c.get('clear-memory').naturalLanguage,false)
  assert.equal(c.allows('id-check',{...t.ctx,groupId:200000003}),false)
  assert.equal(c.enabled('id-check-kick'),false)
 })
 await test('固定回复、别名和参数无需模型，权限与群范围先于执行',async()=>{
  const t=fixture();t.customCommands.upsert({name:'问候',trigger:'/问候',aliases:['/hello'],match:'prefix',reply:'你好{name}：{args}',scope:'group',groups:[200000002]})
  await t.bot.handleMessage(evt('/hello 世界'));assert.equal(t.calls.length,0);assert.equal(t.sent[0].text,'你好测试群友：世界')
  await t.bot.handleMessage(evt('/hello 世界',200000003));assert.equal(t.calls.length,0);assert.equal(t.sent.length,2);assert.match(t.sent[1].text,/未启用/)
  const c=t.customCommands.all()[0];t.customCommands.upsert({...c,adminOnly:true});t.commandCenter.touch();await t.bot.handleMessage(evt('/hello 世界'));assert.equal(t.calls.length,0)
  t.config.adminUsers=['200000011'];await t.bot.handleMessage(evt('/hello 世界'));assert.equal(t.sent.at(-1).text,'你好测试群友：世界')
 })
 await test('创建时调用一次模型，生成固定草稿后执行不再调用模型，也不会自动保存',async()=>{
  const t=fixture();t.setResult(JSON.stringify({name:'早安',trigger:'早安',reply:'早上好{name}',event:'message',match:'exact'}))
  const draft=await t.commandCenter.generate('早安时给一句固定问候',{mode:'fixed'})
  assert.equal(t.calls.length,1);assert.equal(t.customCommands.all().length,0);assert.equal(draft.enabled,false)
  t.customCommands.upsert({...draft,enabled:true});await t.bot.handleMessage(evt('早安'));assert.equal(t.calls.length,1);assert.equal(t.sent[0].text,'早上好测试群友')
  t.setResult(JSON.stringify({error:'不支持运行外部程序'}));await assert.rejects(t.commandCenter.generate('外部程序'),/不支持/)
 })
 await test('自然语言识别仅对主动对话及已授权候选启用，AI规则才可启用语义匹配',async()=>{
  const t=fixture(),c=t.customCommands.upsert({name:'鼓励',trigger:'/鼓励',reply:'',responseMode:'ai',aiPrompt:'一句鼓励',description:'用户想听一句鼓励',naturalLanguage:true,scope:'group',groups:[200000002],adminOnly:true})
  t.setResult(JSON.stringify({key:'custom:'+c.id}));assert.equal(await t.commandCenter.resolve('鼓励一下',t.ctx),null);assert.equal(t.calls.length,0)
  t.config.adminUsers=['200000011'];assert.equal(await t.commandCenter.resolve('鼓励一下',{...t.ctx,direct:false}),null);assert.equal(t.calls.length,0)
  assert.equal(await t.commandCenter.resolve('鼓励一下',{...t.ctx,groupId:200000003}),null);assert.equal(t.calls.length,0)
  const selected=await t.commandCenter.resolve('给我打打气',t.ctx);assert.equal(selected.command.id,c.id);assert.equal(t.calls.length,1)
  t.setResult('可以慢慢来。');assert.equal(await t.commandCenter.respond(c,{...t.ctx,text:'给我打打气'}),'可以慢慢来。');assert.equal(t.calls.length,2)
  t.customCommands.upsert({...c,responseMode:'fixed',reply:'固定回复'});assert.equal(t.customCommands.all()[0].naturalLanguage,false)
 })
 await test('已有群总结支持可选自然语言描述，仍使用原天数参数与群实现',async()=>{
  const t=fixture();t.commandCenter.saveBuiltin({...t.commandCenter.get('summary'),naturalLanguage:true})
  t.setResult('{"key":"builtin:summary","days":3}');await t.bot.handleMessage(evt('帮我总结最近三天的群聊'))
  assert.equal(t.calls.length,1);assert.deepEqual(t.triggers,[{groups:[200000002],options:{days:3}}])
  t.commandCenter.saveBuiltin({...t.commandCenter.get('summary'),enabled:false});await t.bot.handleMessage(evt('/群总结'))
  assert.equal(t.triggers.length,1);assert.equal(t.calls.length,1)
 })
 await test('AI理解只能选择提供的候选，不能通过输出伪造管理动作',async()=>{
  const t=fixture();t.commandCenter.saveBuiltin({...t.commandCenter.get('help'),naturalLanguage:true})
  t.setResult('{"key":"builtin:clear-memory"}');assert.equal(await t.commandCenter.resolve('任意文字',t.ctx),null)
  t.setResult('不是 JSON');assert.equal(await t.commandCenter.resolve('任意文字',t.ctx),null)
 })
 await test('生成中的自定义AI回复在关闭指令或清理记忆后取消',async()=>{
  for(const reset of [false,true]){
   const t=fixture();const c=t.customCommands.upsert({trigger:'/测试AI',responseMode:'ai',aiPrompt:'简短回答'})
   let release,entered;const started=new Promise(r=>entered=r)
   t.setResult(()=>{entered();return new Promise(r=>release=r)})
   const task=t.bot.handleMessage(evt('/测试AI'));await started
   if(reset)t.memory.clearKey('g200000002');else{t.customCommands.upsert({...c,enabled:false});t.commandCenter.touch()}
   release('过期回答');await task;assert.equal(t.sent.length,0);assert.equal(t.memory.count('g200000002'),0)
  }
 })
 await test('拍一拍检测包括关闭回应时的真实事件；自定义事件规则与原有语料可并存',async()=>{
  const t=fixture(),notice={notice_type:'notify',sub_type:'poke',target_id:200000010,user_id:200000011,group_id:200000002}
  await t.bot.handleNotice(notice);assert.equal(t.sent[0].text,'原有私有拍一拍语料');assert.equal(t.calls.length,0)
  await t.bot.handleNotice(notice);assert.equal(t.sent.length,1,'重复通知不重复回应')
  t.advance(2000);t.commandCenter.saveBuiltin({...t.commandCenter.get('poke'),enabled:false});await t.bot.handleNotice(notice);assert.equal(t.sent.length,1);assert.equal(t.commandCenter.diagnostics().count,3)
  t.commandCenter.saveBuiltin({...t.commandCenter.get('poke'),enabled:true});t.customCommands.upsert({event:'poke',name:'拍一拍规则',reply:'收到了{name}',scope:'group',groups:[200000002]})
  t.advance(2000);await t.bot.handleNotice(notice);assert.equal(t.sent.at(-1).text,'收到了群友')
  t.advance(2000);await t.bot.handleNotice({...notice,group_id:200000003});assert.equal(t.sent.at(-1).text,'原有私有拍一拍语料')
 })
 await test('自动+1遵守独立开关、所选群和管理员条件，仍不经过模型',async()=>{
  const t=fixture();t.commandCenter.saveBuiltin({...t.commandCenter.get('auto-plus-one'),scope:'group',groups:[200000002],adminOnly:true})
  for(let i=0;i<2;i++)await t.bot.handleMessage(evt('复读测试',200000002,200000011,false))
  assert.equal(t.repeated.length,0);t.config.adminUsers=['200000011']
  for(let i=0;i<3;i++)await t.bot.handleMessage(evt('新的复读',200000002,200000011,false))
  assert.equal(t.repeated.length,1)
  for(let i=0;i<2;i++)await t.bot.handleMessage(evt('其他群复读',200000003,200000011,false))
  assert.equal(t.repeated.length,1);assert.equal(t.calls.length,0)
 })
 await test('导出不含凭据和记忆，导入先预览、追加并关闭，不覆盖同名规则',()=>{
  const t=fixture();t.customCommands.upsert({name:'已有规则',trigger:'测试',reply:'回复',scope:'group',groups:[200000002],scheduleEnabled:true,scheduleTimes:['12:00'],scheduleGroups:[200000002]})
  const pack=t.commandCenter.exportPack();assert.deepEqual(pack.commands[0].groups,[]);assert.deepEqual(pack.commands[0].scheduleGroups,[])
  const content=JSON.stringify(pack),preview=t.commandCenter.preview(content);assert.equal(preview.commands[0].enabled,false);assert.equal(preview.commands[0].scheduleEnabled,false);assert.equal(t.customCommands.all().length,1)
  const r=t.commandCenter.importPack(content);assert.equal(r.added,1);assert.equal(r.builtins,0);assert.equal(t.commandCenter.enabled('summary'),true)
  assert.equal(t.customCommands.all()[0].enabled,true);assert.equal(t.customCommands.all()[1].enabled,false);assert.notEqual(t.customCommands.all()[1].name,'已有规则')
  const exportedWithGroups=t.commandCenter.exportPack({id:t.customCommands.all()[0].id,includeGroups:true});assert.deepEqual(exportedWithGroups.commands[0].groups,[200000002])
  assert.throws(()=>t.commandCenter.preview('{"format":"other"}'))
  const bad=structuredClone(pack);bad.commands[0].responseMode='shell';assert.throws(()=>t.commandCenter.preview(JSON.stringify(bad)),/仅支持/)
  assert.throws(()=>t.commandCenter.preview('x'.repeat(262145)),/256/)
  t.commandCenter.importPack(content,{includeBuiltins:true});assert.equal(t.commandCenter.enabled('summary'),false)
  const restored=createCommandCenter({file:path.join(t.dir,'center.json'),customCommands:t.customCommands,config:t.config,logger,llm:t.llm});assert.equal(restored.enabled('summary'),false)
 })
 await test('控制台动作生成草稿、预览和拍一拍检测均不执行QQ动作',async()=>{
  const t=fixture(),admin=createAdminServer({...t,logger})
  try{t.setResult('{"trigger":"早安","reply":"早上好","name":"问候"}')
   await admin.actions['generate-command']({description:'早安回复',mode:'fixed'});assert.equal(t.customCommands.all().length,0)
   assert.equal((await admin.actions['check-poke']()).enabled,true)
   const data=await admin.routes['GET /api/custom-commands']();assert.equal(data.builtinItems.length,9)
   assert.equal(t.sent.length,0)
   await assert.rejects(admin.actions['save-custom-command']({trigger:'/群总结',reply:'伪总结'}),/内置功能/)
  }finally{admin.server.close()}
 })
 await test('名片核对可调整适用群，但不能因此绕过原操作员权限',async()=>{
  const t=fixture(),lookups=[];t.onebot.getGroupMemberList=async g=>{lookups.push(g);return []}
  await t.bot.handleMessage(evt('/id_check',200000003));assert.equal(lookups.length,0)
  t.commandCenter.saveBuiltin({...t.commandCenter.get('id-check'),scope:'group',groups:[200000003]})
  await t.bot.handleMessage(evt('/id_check',200000003));assert.deepEqual(lookups,[200000003])
  await t.bot.handleMessage(evt('/id_check',200000003,200000012));assert.equal(lookups.length,1);assert.equal(t.calls.length,0)
 })
 await test('定时规则不能越过群范围，AI规则不能伪装成免费定时规则',()=>{
  const t=fixture(),d=new Date(),time=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')
  t.customCommands.upsert({trigger:'/定时',reply:'固定消息',scope:'group',groups:[200000002],scheduleEnabled:true,scheduleTimes:[time],scheduleGroups:[200000002,200000003]})
  assert.deepEqual(t.customCommands.due(d.getTime()).map(x=>x.groupId),[200000002])
  assert.throws(()=>t.customCommands.upsert({trigger:'/AI',responseMode:'ai',aiPrompt:'回答',scheduleEnabled:true}),/仅支持/)
  const pack=t.commandCenter.exportPack({id:t.customCommands.all()[0].id}),r=t.commandCenter.importPack(JSON.stringify(pack))
  assert.equal(r.added,1);const imported=t.customCommands.all()[1];assert.equal(imported.scope,'group');assert.deepEqual(imported.groups,[])
  assert.throws(()=>t.customCommands.upsert({...imported,enabled:true}),/至少选择/)
 })
 await test('新指令页面可解析、展示已有功能与分开的AI开关，导入和导出内容转义',()=>{
  const t=fixture(),context={window:{},structuredClone,console,Date};vm.createContext(context)
  vm.runInContext(readFileSync(new URL('../src/admin/commandCenter.js',import.meta.url),'utf8'),context)
  const html=context.window.CommandCenterUI.render({custom:[{name:'<script>test</script>',id:'test',enabled:false}],builtins:t.commandCenter.all(),poke:{},groups:[]})
  assert.match(html,/9 项已有功能/);assert.match(html,/调用一次 AI/);assert.match(html,/开始观察拍一拍/)
  assert.match(html,/先预览/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>test/)
 })
 console.log(`${passed} command-center cases passed; no QQ or paid model calls.`)
}finally{for(const m of stores)if(m.timer)clearTimeout(m.timer);assert.equal(path.dirname(root),os.tmpdir());rmSync(root,{recursive:true,force:true})}
