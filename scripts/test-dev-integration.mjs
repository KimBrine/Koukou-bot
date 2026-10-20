// 离线检查控制台编辑冲突与非白名单学习，不连接QQ或模型。
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/memory.js'
import { createLongMemory } from '../src/longMemory.js'
import { createAdminServer } from '../src/admin/server.js'
const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-dev-integration-'))
const logger = { info(){}, warn(){}, error(){}, debug(){} }
const memory = new MemoryStore({ file:path.join(root,'memory.json'), limit:500, logger })
try {
  const longMemory = createLongMemory({ file:path.join(root,'long.json'), logger, llm:{chat:async()=> '摘要'} })
  const config = { rootDir:root, dataDir:root, memoryFile:memory.file, stickerLearnGroups:new Set([12345]) }
  const admin = createAdminServer({ config, memory, longMemory, logger })
  for(let i=0;i<205;i++) memory.push('g','user','内容'+i,{time:Date.now()+i})
  const detail = await admin.routes['GET /api/memory-detail']({key:'g'})
  assert.equal(detail.recent.length,200); assert.equal(detail.recentOffset,5)
  await admin.actions['memory-update']({key:'g',index:detail.recentOffset,content:'修改展示的首条',revision:detail.revision})
  assert.equal(memory.get('g')[5].content,'修改展示的首条'); assert.equal(memory.get('g')[0].content,'内容0')
  await assert.rejects(admin.actions['memory-delete']({key:'g',index:0,revision:detail.revision}), /刷新/)
  await admin.actions['longmemory-pause']({key:'g'})
  const paused = await admin.routes['GET /api/memory-detail']({key:'g'})
  assert.equal(paused.paused,true)
  await admin.actions['longmemory-update']({key:'g',text:'手动摘要'})
  assert.equal(longMemory.detail('g').paused,true)
  await admin.actions['longmemory-resume']({key:'g'})
  assert.equal(longMemory.detail('g').paused,false)
  longMemory.addEvicted('g',[{text:'第一条'},{text:'第二条'}])
  const oldPending = await admin.routes['GET /api/memory-detail']({key:'g'})
  longMemory.removePending('g',0)
  await assert.rejects(admin.actions['pending-delete']({key:'g',index:0,revision:oldPending.pendingRevision}), /刷新/)
  const html=readFileSync(new URL('../src/admin/ui.html',import.meta.url),'utf8')
  const js=/<script>([\s\S]*?)<\/script>/.exec(html)[1]
  const prefix=js.slice(0,js.search(/\r?\nrenderNav\(\)\r?\nload\(\)/))
  const context=vm.createContext({location:{hash:''},console})
  vm.runInContext(prefix,context)
  const stickerPage=vm.runInContext(`joinedGroups=[{id:'12345',name:'非白名单群'}]; chats=[]; stickerLearn={groups:[12345]}; pageStickers()`,context)
  assert.match(stickerPage,/data-stk-learn-group="12345" checked/)
  assert.match(stickerPage,/非白名单群/)
  const memoryPage=vm.runInContext(`memoryDetail={key:'g',recent:[],pending:[],paused:false}; pageMemory()`,context)
  assert.match(memoryPage,/id="lmEdit" disabled/)
  assert.match(memoryPage,/暂停整理并编辑/)
  await admin.actions['set-config-batch']({patch:{STICKER_AUTO_RATE:'35',STICKER_MAX_PER_REPLY:'2',STICKER_SEND_SCOPE:'selected',STICKER_SEND_GROUPS:'12345',STICKER_PICK_MODE:'model',STICKER_COOLDOWN_SECONDS:'60'}})
  assert.equal(config.stickerAutoRate,.35);assert.equal(config.stickerMaxPerReply,2)
  assert.equal(config.stickerSendGroups.has(12345),true);assert.equal(config.stickerPickMode,'model')
  const persisted=readFileSync(path.join(root,'.env'),'utf8');assert.match(persisted,/STICKER_AUTO_RATE=35/)
  await assert.rejects(admin.actions['set-config-batch']({patch:{STICKER_AUTO_RATE:'101'}}),/概率/)
  await assert.rejects(admin.actions['set-config-batch']({patch:{STICKER_SEND_SCOPE:'bad'}}),/范围/)
  const editor=vm.runInContext(`stickerList=[{id:'sample',name:'示例',hash:'a'.repeat(64),description:'<script>不能执行</script>',keywords:['开心']}];pageStickers()`,context)
  assert.match(editor,/data-stk-desc="sample"/);assert.match(editor,/data-stk-file="sample"/)
  assert.match(editor,/SHA-256/);assert.match(editor,/stkPreviewDialog/)
  assert.ok(editor.includes('a'.repeat(64)));assert.ok(editor.includes('&lt;script&gt;'))
  assert.match(editor,/stkRulesSave/);assert.match(editor,/stkPickMode/)
  console.log('控制台集成通过：200条偏移、并发编辑保护、暂停恢复、非白名单群多选和页面渲染。')
} finally { memory.flush(); rmSync(root,{recursive:true,force:true}) }
