import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import {createAdminServer} from '../src/admin/server.js'
import {createChatSettings} from '../src/chatSettings.js'
import {decideReply} from '../src/bot.js'
const root=mkdtempSync(path.join(os.tmpdir(),'private-manager-')),envFile=path.join(root,'.env')
const config={rootDir:root,dataDir:root,envFile,memoryFile:path.join(root,'memory.json'),whitelistGroups:new Set(),mutedGroups:new Set(),adminUsers:['200000099'],privateWhitelist:new Set([200000001]),quietHoursBlockAll:false,proactiveRate:0}
writeFileSync(envFile,'# keep\nPRIVATE_WHITELIST=200000001\nUNRELATED=keep\n')
writeFileSync(config.memoryFile,JSON.stringify({p200000003:[{role:'user',content:'仅历史'}]}))
const chatSettings=createChatSettings({file:path.join(root,'chats.json')})
chatSettings.set('p200000004',{});chatSettings.set('p200000005',{enabled:false})
const onebot={api:async name=>name==='get_friend_list'?[{user_id:200000002,nickname:'好友甲'}]:[]}
const admin=createAdminServer({config,chatSettings,onebot})
try{
 const result=await admin.actions['add-private-whitelist']({userIds:['200000002','200000002','200000001']})
 assert.equal(result.changed,1);assert.deepEqual([...config.privateWhitelist],[200000001,200000002])
 assert.equal(chatSettings.raw('p200000002'),null,'加白名单不创建独立设置，不改变其他放行来源')
 await Promise.all([admin.actions['add-private-whitelist']({userIds:['200000006']}),admin.actions['add-private-whitelist']({userIds:['200000007']})])
 assert.deepEqual([...config.privateWhitelist],[200000001,200000002,200000006,200000007])
 const before=readFileSync(envFile,'utf8')
 await assert.rejects(admin.actions['add-private-whitelist']({userIds:['200000008','bad']}),/QQ号/)
 assert.equal(readFileSync(envFile,'utf8'),before)
 assert.match(before,/# keep/);assert.match(before,/UNRELATED=keep/)
 const rows=(await admin.routes['GET /api/chats']()).items
 assert.ok(rows.some(c=>c.key==='p200000002'&&c.name==='好友甲'&&c.privateAccess.listed))
 assert.ok(rows.some(c=>c.key==='p200000099'&&c.privateAccess.admin))
 assert.equal(rows.find(c=>c.key==='p200000003').privateAccess.configured,false)
 assert.equal(rows.find(c=>c.key==='p200000004').privateAccess.configured,true)
 assert.equal(decideReply({isPrivate:true,config,chatSettings,chatKey:'p200000002'}).reply,true)
 assert.equal(decideReply({isPrivate:true,config,chatSettings,chatKey:'p200000003'}).reply,false)
 assert.equal(decideReply({isPrivate:true,config,chatSettings,chatKey:'p200000005'}).reply,false)
 const badEnv=path.join(root,'bad-env');mkdirSync(badEnv)
 const badConfig={...config,envFile:badEnv,privateWhitelist:new Set([200000001])},bad=createAdminServer({config:badConfig,chatSettings,onebot})
 await assert.rejects(bad.actions['add-private-whitelist']({userIds:['200000002']}))
 assert.deepEqual([...badConfig.privateWhitelist],[200000001],'落盘失败不能提前放行')
 const app=readFileSync(new URL('../src/admin/app.js',import.meta.url),'utf8')
 const elements=Object.fromEntries(['whitelistInput','whitelistPick','whitelistPreview','importCommit','importCancel'].map(id=>[id,{value:'',focus(){}}]))
 const modal={innerHTML:'',classList:{add(){},remove(){}},setAttribute(){},querySelector:s=>elements[s.slice(1)]}
 const document={getElementById:id=>id==='modalRoot'?modal:{focus(){}},addEventListener(){},removeEventListener(){}}
 let posted
 const context=vm.createContext({location:{hash:'#chats'},window:{},document,fetch:async(url,options)=>{posted={url,body:JSON.parse(options.body)};return {ok:true,json:async()=>({changed:2})}}})
 vm.runInContext(app.slice(0,app.search(/\r?\nrenderNav\(\)\r?\nload\(\)/)),context)
 context.rows=rows
 vm.runInContext(`state={config:{privateWhitelist:[200000001],adminUsers:['200000099'],whitelist:[]}};chats=rows;friendList=[{id:'200000020',name:'可选好友'}];load=async()=>{};toast=()=>{}`,context)
 let html=vm.runInContext('pageChats()',context)
 assert.match(html,/id="addPrivateWhitelist"/);assert.match(html,/id="addPrivateWhitelistBelow"/);assert.match(html,/id="addPrivateWhitelistTop"/)
 assert.match(html,/管理员自动允许/);assert.match(html,/已配置私聊/)
 const allowed=vm.runInContext('privateWhitelistEntries()',context)
 assert.equal(allowed.some(c=>c.id==='200000003'),false,'仅历史私聊不显示为已放行')
 await vm.runInContext('importWhitelist({privateChat:true})',context)
 assert.match(modal.innerHTML,/添加私聊白名单/);assert.match(modal.innerHTML,/可选好友/)
 assert.equal(elements.importCommit.disabled,true)
 elements.whitelistInput.value='bad';elements.whitelistInput.oninput();assert.equal(elements.importCommit.disabled,true)
 elements.whitelistInput.value='200000001,200000020\n200000020 200000021';elements.whitelistInput.oninput()
 assert.equal(elements.importCommit.disabled,false);await elements.importCommit.onclick()
 assert.equal(posted.url,'/api/action/add-private-whitelist');assert.deepEqual(posted.body.userIds,['200000020','200000021'])
 console.log('Private manager checks passed: discoverable entries, source labels, batch add/deduplication, failure atomicity, unchanged settings and no automatic messages.')
}finally{admin.server.close();rmSync(root,{recursive:true,force:true})}
