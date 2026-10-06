import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createAdminServer } from '../src/admin/server.js'
import { createChatSettings } from '../src/chatSettings.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-admin-groups-'))
const envFile = path.join(root, '.env')
writeFileSync(envFile, '# preserve comment\nWHITELIST_GROUPS=200000019\nPROACTIVE_RATE_PER_GROUP=200000019:0.2\nUNRELATED=keep\n')
const config = {rootDir:root, dataDir:root, envFile, memoryFile:path.join(root,'memory.json'), whitelistGroups:new Set([200000019]), proactiveRate:0.1, proactiveRatePerGroup:new Map([[200000019,0.2]])}
const chatSettings = createChatSettings({file:path.join(root,'chats.json')})
chatSettings.set('g200000019', {customPrompt:'keep prompt', proactiveRate:0.35})
const admin = createAdminServer({config, chatSettings, onebot:{api:async name => name === 'get_group_list' ? [{group_id:200000019,group_name:'示例群 A'},{group_id:200000002,group_name:'测试群'}] : []}})
try {
  const add = await admin.actions['update-whitelist']({operation:'add',groupIds:['200000002','200000002','200000019']})
  assert.equal(add.changed,1)
  assert.deepEqual([...config.whitelistGroups],[200000019,200000002])
  assert.match(readFileSync(envFile,'utf8'), /WHITELIST_GROUPS=200000019,200000002/)
  await admin.actions['update-whitelist']({operation:'remove',groupIds:['200000019']})
  assert.deepEqual([...config.whitelistGroups],[200000002])
  assert.equal(chatSettings.raw('g200000019').customPrompt,'keep prompt')
  assert.equal(config.proactiveRatePerGroup.get(200000019),0.2)
  const beforeInvalid = readFileSync(envFile,'utf8')
  await assert.rejects(admin.actions['update-whitelist']({operation:'add',groupIds:['12345','bad-id']}))
  assert.equal(readFileSync(envFile,'utf8'),beforeInvalid)
  const saved = await admin.actions['set-config-batch']({patch:{PROACTIVE_RATE_PER_GROUP:'200000019:0.2,200000002:0'}})
  assert.equal(saved.live,1)
  assert.equal(config.proactiveRateFor(200000019),0.2)
  assert.equal(config.proactiveRateFor(200000002),0)
  assert.equal(config.proactiveRateFor(200000017),0.1)
  assert.equal(chatSettings.resolve('g200000019',config).proactiveRate,0.35)
  for (const value of ['200000019:20','200000019:-0.1','200000019:0.2,200000019:0.3','bad:0.2']) {
    const before = readFileSync(envFile,'utf8')
    await assert.rejects(admin.actions['set-config-batch']({patch:{PROACTIVE_RATE_PER_GROUP:value}}))
    assert.equal(readFileSync(envFile,'utf8'),before)
  }
  await admin.actions['set-config-batch']({patch:{PROACTIVE_RATE_PER_GROUP:''}})
  assert.equal(config.proactiveRateFor(200000019),0.1)
  const groups = await admin.routes['GET /api/groups']()
  assert.equal(groups.items[0].name,'示例群 A')
  assert.match(readFileSync(envFile,'utf8'), /# preserve comment/)
  assert.match(readFileSync(envFile,'utf8'), /UNRELATED=keep/)
  const html = readFileSync(new URL('../src/admin/ui.html',import.meta.url),'utf8')
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1])
  console.log('Group management checks passed: persistence, deduplication, invalid input, preserved settings, probability precedence, UI syntax')
} finally {
  admin.server.close()
  const resolved = path.resolve(root)
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
  rmSync(resolved,{recursive:true,force:true})
}
