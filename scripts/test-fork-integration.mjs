// 全部为临时文件、模型替身和 QQ 替身，不连接真实服务。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MemoryStore } from '../src/memory.js'
import { createLongMemory } from '../src/longMemory.js'
import { createChatSettings } from '../src/chatSettings.js'
import { applyConversationSettings, resetConversationMemory, prepareSessionPersona } from '../src/conversationSessions.js'
import { createTargetWatch } from '../src/targetWatch.js'
import { createBot } from '../src/bot.js'
import { createChatPromptBuilder } from '../src/chatPrompt.js'
import { createAdminServer } from '../src/admin/server.js'

const root=mkdtempSync(path.join(os.tmpdir(),'koukou-integrate-')), stores=[]
const logger={info(){},warn(){},debug(){},error(){}}
let sequence=0,passed=0
async function test(name,run){await run();passed++;console.log('PASS '+name)}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(llm={async chat(){return '模拟摘要'}}){
  const dir=path.join(root,String(++sequence));mkdirSync(dir)
  const memory=new MemoryStore({file:path.join(dir,'memory.json'),limit:99,logger});stores.push(memory)
  const longMemory=createLongMemory({file:path.join(dir,'long.json'),maxBatch:999,logger,llm})
  const chatSettings=createChatSettings({file:path.join(dir,'settings.json'),logger})
  const config={rootDir:dir,dataDir:dir,personaDir:path.join(dir,'personas'),persona:'全局人格甲',activePersona:'甲',longMemoryEnabled:true,
    whitelistGroups:new Set([200000002,200000003]),mutedGroups:new Set(),quietHours:'',autoPlusOneEnabled:false,proactiveRate:0,
    contextRememberAll:true,replyMaxLines:1,replyLineMaxChars:40,replyLengthMatch:false,emojiKeepRate:0,
    humanDelayMinMs:0,humanDelayMaxMs:0,lineGapMinMs:0,lineGapMaxMs:0,targetWatchIntervalMs:600000}
  mkdirSync(config.personaDir);writeFileSync(path.join(config.personaDir,'乙.txt'),'独立人格乙')
  return {dir,memory,longMemory,chatSettings,config}
}
const event=(text,g=200000002,u=200000011)=>({post_type:'message',message_type:'group',group_id:g,user_id:u,message_id:Math.random(),time:Date.now()/1000,
  sender:{nickname:'模拟群友'},message:[{type:'at',data:{qq:'200000010'}},{type:'text',data:{text}}]})
function bot(t,llm){
  const sent=[],onebot={selfId:'200000010',async sendGroup(g,text){sent.push({g,text});return {message_id:9}}}
  const instance=createBot({...t,logger,onebot,llm,buildSystemPrompt:createChatPromptBuilder(t)})
  return {instance,sent,onebot}
}
try{
  await test('单会话清理同时隔离原文与补读，重启仍有效且不影响另一群',()=>{
    const t=fixture(),key='g200000002',other='g200000003'
    t.memory.push(key,'user','旧原话',{time:1000});t.memory.push(other,'user','别群原话',{time:1000})
    t.longMemory.addEvicted(key,[{text:'公园约定周六下午四点见',time:1000}]);t.longMemory.addEvicted(other,[{text:'公园约定周日见',time:1000}])
    const before=t.memory.version(key),otherBefore=t.memory.version(other)
    resetConversationMemory({...t,key})
    assert.notEqual(t.memory.version(key),before);assert.equal(t.memory.version(other),otherBefore)
    assert.equal(t.longMemory.get(key,{query:'公园约定'}),'');assert.match(t.longMemory.get(other,{query:'公园约定'}),/周日/)
    assert.equal(t.memory.push(key,'user','登录旧补读',{time:1000,historical:true}),false)
    const restored=new MemoryStore({file:t.memory.file,limit:99,logger});stores.push(restored);restored.load()
    assert.equal(restored.push(key,'user','再次旧补读',{time:1000,historical:true}),false)
    const long=createLongMemory({file:path.join(t.dir,'long.json'),logger})
    assert.equal(long.get(key,{query:'公园约定'}),'')
  })
  await test('全部清理包括只有长期记忆、没有近期记录的会话',()=>{
    const t=fixture();t.longMemory.addEvicted('g200000003',[{text:'只在长期存在的原话'}])
    const r=resetConversationMemory(t);assert.equal(r.longTerm,1);assert.deepEqual(t.longMemory.stats(),[])
    assert.equal(t.longMemory.get('g200000003',{query:'长期存在原话'}),'')
  })
  await test('清理中止在途压缩及历史回填，不在下一批重新加入旧内容',async()=>{
    const d=deferred(),entered=deferred(),t=fixture({async chat(){entered.resolve();return d.promise}})
    const task=t.longMemory.feed('g200000002',[{text:'旧批次'},{text:'不该再加入的批次'}],{batchSize:1})
    await entered.promise;resetConversationMemory({...t,key:'g200000002'});d.resolve('过期摘要')
    assert.equal(await task,false);assert.deepEqual(t.longMemory.stats(),[])
  })
  await test('按群切换只清本群，重复同版本不清；修改正文后下一轮再次建立边界',()=>{
    const t=fixture(),key='g200000002';t.memory.push(key,'assistant','甲的口头禅');t.memory.push('g200000003','assistant','别群保留')
    const r=applyConversationSettings({...t,key,patch:{persona:'乙'}});assert.ok(r.reset);assert.equal(t.memory.count(key),0)
    assert.equal(t.memory.count('g200000003'),1);t.memory.push(key,'assistant','乙的回答')
    assert.equal(applyConversationSettings({...t,key,patch:{persona:'乙'}}).reset,null);assert.equal(t.memory.count(key),1)
    writeFileSync(path.join(t.config.personaDir,'乙.txt'),'乙的修改正文')
    assert.equal(prepareSessionPersona({...t,key}),'乙的修改正文');assert.equal(t.memory.count(key),0)
    assert.throws(()=>applyConversationSettings({...t,key,patch:{persona:'不存在'}}),/不存在/)
  })
  await test('切换写入失败时回滚近期、长期与检索分区，原设置仍生效',()=>{
    const t=fixture(),key='g200000002';t.memory.push(key,'user','保留原话')
    t.longMemory.addEvicted(key,[{text:'公园约定原话保留'}]);const before=t.memory.snapshot()
    assert.throws(()=>resetConversationMemory({...t,key,persist(){throw Error('模拟写入失败')}}),/已保留原记忆/)
    assert.deepEqual(t.memory.snapshot(),before);assert.match(t.longMemory.get(key,{query:'公园约定'}),/原话保留/)
  })
  await test('清理后取消生成中的旧回答，不发送也不重新写入记忆',async()=>{
    const t=fixture(),d=deferred(),entered=deferred(),b=bot(t,{async chat(){entered.resolve();return d.promise}})
    const task=b.instance.handleMessage(event('旧问题'));await entered.promise
    resetConversationMemory({...t,key:'g200000002'});d.resolve('过期的旧回答');await task
    assert.deepEqual(b.sent,[]);assert.equal(t.memory.count('g200000002'),0)
  })
  await test('生成中切本群人格或编辑其正文均取消旧回答，别群仍保持原历史',async()=>{
    for(const edit of [false,true]){
      const t=fixture(),key='g200000002'
      if(edit)applyConversationSettings({...t,key,patch:{persona:'乙'}})
      const d=deferred(),entered=deferred(),b=bot(t,{async chat(){entered.resolve();return d.promise}})
      const task=b.instance.handleMessage(event('旧问题'));await entered.promise
      if(edit)writeFileSync(path.join(t.config.personaDir,'乙.txt'),'乙的新正文')
      else applyConversationSettings({...t,key,patch:{persona:'乙'}})
      d.resolve('过期回答');await task;assert.deepEqual(b.sent,[])
    }
  })
  await test('盯人目标切群或关闭后取消旧生成；后续新群回复目的地固定正确',async()=>{
    for(const disable of [false,true]){
      const t=fixture(),d=deferred(),entered=deferred(),sent=[]
      Object.assign(t.config,{targetWatchEnabled:true,targetWatchGroup:200000002,targetWatchUser:200000011})
      let calls=0
      const watch=createTargetWatch({...t,logger,onebot:{selfId:'200000010',async sendGroup(g,text){sent.push({g,text})}},
        llm:{async chat(){if(++calls===1){entered.resolve();return d.promise}return '新的正常回复'}},buildSystemPrompt:createChatPromptBuilder(t)})
      watch.note(event('旧群的话题'),{text:'旧群的话题',atBot:false});const task=watch.tick();await entered.promise
      watch.configure({enabled:!disable,groupId:200000003,userId:200000012});d.resolve('不该串群的回复');await task
      assert.deepEqual(sent,[])
      if(!disable){watch.note(event('新群的话题',200000003,200000012),{text:'新群的话题',atBot:false});await watch.tick()
        assert.equal(sent.length,1);assert.equal(String(sent[0].g),'200000003');assert.equal(sent[0].text[0].data.qq,'200000012')}
      watch.stop()
    }
  })
  await test('未设管理员或非管理员不能从QQ清空记忆，显式管理员可清空',async()=>{
    for(const admins of [[],['200000099'],['200000011']]){
      const t=fixture();t.config.adminUsers=admins;t.memory.push('g200000003','user','不能随便清掉的别群原话')
      const b=bot(t,{async chat(){throw Error('不应调用模型')}});await b.instance.handleMessage(event('/清除记忆 全部'))
      assert.equal(t.memory.count('g200000003'),admins.includes('200000011')?0:1)
    }
  })
  await test('控制台恢复全局人格也重置本会话，普通设置保存不清记忆',async()=>{
    const t=fixture(),key='g200000002',admin=createAdminServer({...t,logger})
    try{
      await admin.actions['set-chat']({key,patch:{persona:'乙'}});t.memory.push(key,'assistant','独立人格旧话')
      await admin.actions['set-chat']({key,patch:{note:'备注'}});assert.equal(t.memory.count(key),1)
      await admin.actions['reset-chat']({key});assert.equal(t.memory.count(key),0)
      assert.equal(t.chatSettings.get(key).persona,'')
    }finally{admin.server.close()}
  })
  console.log(`${passed} cases passed`)
}finally{
  for(const m of stores){if(m.timer)clearTimeout(m.timer);m.flush()}
  assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('koukou-integrate-'));rmSync(root,{recursive:true,force:true})
}
