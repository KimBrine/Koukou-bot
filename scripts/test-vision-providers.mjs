import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createVisionProviders } from '../src/visionProviders.js'

const dir = mkdtempSync(path.join(tmpdir(), 'vp-'))
const file = path.join(dir, 'vision-providers.json')
try {
  const store = createVisionProviders({ file, logger: null })

  // 新增与读取
  const a = store.add({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-test-1234', model: 'gpt-4o-mini' })
  assert.equal(a.name, 'OpenAI')
  assert.equal(a.baseUrl, 'https://api.openai.com/v1', '地址末尾斜杠要去掉')
  assert.equal(a.hasKey, true)
  assert.equal(a.keyHint, '••••1234', 'Key 只回传给末四位')
  assert.equal(JSON.stringify(a).includes('sk-test-1234'), false, '明文 Key 不能下发到界面')

  // 地址必填且必须是 http(s)
  assert.throws(() => store.add({ name: 'x', baseUrl: 'ftp://a', apiKey: 'k' }), /http/)
  assert.throws(() => store.add({ name: 'x', baseUrl: 'https://a', apiKey: '' }), /API Key/)

  // 更新：空 Key 表示不修改
  const b = store.update(a.id, { model: 'gpt-4o' })
  assert.equal(b.model, 'gpt-4o')
  assert.equal(store.get(a.id).apiKey, 'sk-test-1234', '留空不应清掉原 Key')
  store.update(a.id, { apiKey: 'sk-new-9999' })
  assert.equal(store.get(a.id).apiKey, 'sk-new-9999')

  // 删除
  assert.equal(store.remove(a.id), true)
  assert.equal(store.remove('不存在'), false)
  assert.equal(store.list().length, 0)

  // 持久化
  assert.equal(existsSync(file), true)
  assert.equal(Array.isArray(JSON.parse(readFileSync(file, 'utf8'))), true)

  // 旧单条配置迁移
  const file2 = path.join(dir, 'legacy.json')
  const migrated = createVisionProviders({ file: file2, logger: null, legacy: { baseUrl: 'https://legacy/v1', apiKey: 'sk-legacy', model: 'vl-1' } })
  assert.equal(migrated.list().length, 1, '旧的单个自定义配置要迁移成一条')
  assert.equal(migrated.list()[0].model, 'vl-1')
  let fail=false
  const stable=createVisionProviders({file:path.join(dir,'fail.json'),write:()=>{if(fail)throw Error('disk full')}})
  const original=stable.add({baseUrl:'https://example.test/v1',apiKey:'unit-key',model:'vision-a'})
  fail=true
  assert.throws(()=>stable.update(original.id,{model:'vision-b'}),/disk full/)
  assert.equal(stable.get(original.id).model,'vision-a','写盘失败不改内存')
  assert.throws(()=>stable.remove(original.id),/disk full/)
  assert.equal(stable.count(),1)
  assert.throws(()=>stable.add({baseUrl:'https://example.test',apiKey:'new'}),/disk full/)
  assert.equal(stable.count(),1)
  const copied=stable.get(original.id);copied.model='bad';assert.equal(stable.get(original.id).model,'vision-a')
  migrated.remove(migrated.list()[0].id)
  const noResurrect=createVisionProviders({file:file2,legacy:{baseUrl:'https://legacy/v1',apiKey:'unit-key',model:'vl-1'}})
  assert.equal(noResurrect.count(),0,'手动清空后不能重新迁移旧条目')

  console.log('自定义识图存储检查通过：新增 / 校验 / 更新 / 删除 / 持久化 / 迁移 / Key 打码。')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
