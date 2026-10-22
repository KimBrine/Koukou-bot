// Isolated filesystem and model doubles only: no QQ messages or paid requests.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLongMemory } from '../src/longMemory.js'
import { MemoryStore } from '../src/memory.js'
import { createBackup, applyPendingRestore } from '../src/backup.js'
import { createAdminServer } from '../src/admin/server.js'
import { createPersonaStickers } from '../src/personaStickers.js'
import { createStickerLearner } from '../src/stickerLearn.js'
import { createImageHasher } from '../src/imagehash.js'
import { activatePersona } from '../src/personaSwitch.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-merge-safety-'))
const logger = { info() {}, warn() {}, error() {} }
const stores = []
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
try {
  // A late second compression cannot overwrite a manual edit, even if abort is ignored.
  const entered = deferred(), result = deferred()
  let calls = 0
  const longFile = path.join(root, 'race.json')
  const long = createLongMemory({ file: longFile, logger, maxChars: 20, maxBatch: 1000,
    llm: { async chat() { if (++calls === 1) return '超长初稿'.repeat(30); entered.resolve(); return result.promise } } })
  long.addEvicted('g1', [{ text: '原事实', time: Date.now() }])
  const summarize = long.summarize('g1')
  await entered.promise
  long.setSummary('g1', '人工内容')
  result.resolve('迟到的压缩')
  assert.equal(await summarize, false)
  assert.equal(JSON.parse(readFileSync(longFile)).g1.summary, '人工内容')
  assert.equal(long.detail('g1').paused, true)

  const dir = path.join(root, 'backup')
  const memory = new MemoryStore({ file: path.join(dir, 'memory.json'), limit: 20, logger }); stores.push(memory)
  memory.load(); memory.push('g1', 'user', '旧内容'); memory.flush()
  const config = { dataDir: dir, rootDir: dir, memoryFile: memory.file, activePersona: 'A' }
  let time = 1800000000000
  const backup = createBackup({ config, logger, now: () => time })
  const first = backup.run()
  memory.push('g1', 'user', '新内容'); memory.flush()
  const second = backup.run()
  assert.notEqual(first.name, second.name, '同一秒备份不覆盖')
  assert.equal(JSON.parse(readFileSync(path.join(first.dir, 'memory.json'))).g1.length, 1)
  assert.equal(backup.lastBackupAt(), time)
  // Retention must not remove the newly-created backup when clocks tie.
  for (let i = 0; i < 9; i++) { time += 1000; assert.ok(existsSync(backup.run({ keep: 20 }).dir)) }
  const queued = backup.queueRestore(first.name)
  assert.equal(queued.pending, true)
  assert.equal(memory.get('g1').length, 2)
  assert.equal(JSON.parse(readFileSync(memory.file)).g1.length, 2, '排队不热替换正在使用的文件')
  assert.equal(existsSync(first.dir), false, '原备份被保留策略清理后仍可使用已固定的还原副本')
  memory.push('g1', 'user', '排队后新消息'); memory.flush()
  writeFileSync(path.join(dir, 'unrelated.txt'), '保留')
  assert.equal(applyPendingRestore({ config, logger }), true)
  assert.equal(JSON.parse(readFileSync(memory.file)).g1.length, 1)
  assert.equal(readFileSync(path.join(dir, 'unrelated.txt'), 'utf8'), '保留')
  assert.equal(applyPendingRestore({ config, logger }), false)
  config.activePersona = 'B'
  assert.throws(() => backup.queueRestore(second.name), /备份|找不到|人格|ENOENT/)
  config.activePersona = 'A'

  // Retagging uses model-compatible image data and preserves edits made during the request.
  const libraries = createPersonaStickers({ dir: path.join(dir, 'stickers'), config })
  const item = libraries.add({ name: '原名称', dataUrl: PNG }).item
  const tagging = deferred(), tagEntered = deferred()
  let imageURL
  const tagClient = { model: 'qwen-test', async describeImages(p, text, images) {
    imageURL = images[0].image_url.url; tagEntered.resolve(); await tagging.promise
    return JSON.stringify({ isSticker: true, name: '自动名称', keywords: ['开心'], description: '自动描述', scenes: ['happy'] })
  } }
  const admin = createAdminServer({ config, stickers: libraries, stickerTagLLM: tagClient })
  const scope = libraries.scope().token
  await admin.actions['retag-stickers']({ stickerScope: scope })
  await tagEntered.promise
  libraries.update(item.id, { name: '人工名称', description: '人工描述' })
  tagging.resolve()
  for (let i = 0; i < 100; i++) {
    if (!(await admin.routes['GET /api/stickers/retag-status']({ scope })).running) break
    await new Promise(r => setTimeout(r, 1))
  }
  assert.match(imageURL, /^data:image\/png;base64,/)
  assert.equal(libraries.get(item.id).name, '人工名称')
  assert.equal(libraries.get(item.id).description, '人工描述')
  assert.equal((await admin.routes['GET /api/stickers/retag-status']({ scope })).skipped, 1)
  libraries.update(item.id, {keywords:'',description:''})
  await admin.actions['retag-stickers']({stickerScope:scope,onlyMissing:true})
  for(let i=0;i<100;i++){if(!(await admin.routes['GET /api/stickers/retag-status']({scope})).running)break;await new Promise(r=>setTimeout(r,1))}
  assert.equal(libraries.get(item.id).name,'人工名称','只补缺失资料不能替换已有名称')
  assert.equal(libraries.get(item.id).description,'自动描述')
  config.activePersona = 'B'; config.personaRevision = 1
  await assert.rejects(admin.actions['retag-stickers']({ stickerScope: scope }), /人格/)
  assert.equal((await admin.routes['GET /api/stickers/retag-status']({ scope })).total, 0)

  // Switching while similarity checking is in-flight must not admit a late learned image.
  config.stickerLearnEnabled = true; config.stickerLearnGroups = new Set([12345]); config.stickerLearnPerHour = 20
  const similarEntered = deferred(), similarResult = deferred()
  const learner = createStickerLearner({ config, stickers: libraries, logger,
    imageCache: { load: async () => ({ part: { image_url: { url: PNG } } }) },
    filterLLM: { describeImages: async () => '{"isSticker":true}' },
    tagLLM: { describeImages: async () => '{"isSticker":true,"name":"延迟收录"}' },
    similar: async (_url, selected) => { assert.equal(selected.store, libraries.forChat('g12345')); similarEntered.resolve(); return similarResult.promise } })
  const learning = learner.learnFromMessage({ groupId: 12345, images: [{}] })
  await similarEntered.promise
  config.activePersona = 'C'; config.personaRevision++
  similarResult.resolve(false); assert.equal(await learning, null)
  assert.equal(libraries.count(), 0)
  config.activePersona = 'B'; assert.equal(libraries.count(), 0)

  const hasher = createImageHasher({ config, logger })
  hasher.cache[path.join(dir, 'A', 'same.png')] = { hash: '0'.repeat(64) }
  hasher.cache[path.join(dir, 'B', 'same.png')] = { hash: '1'.repeat(64) }
  assert.notEqual(hasher.hashOf({ file: 'same.png' }, path.join(dir, 'A')), hasher.hashOf({ file: 'same.png' }, path.join(dir, 'B')))
  assert.equal(hasher.distance('0'.repeat(64), '1'.repeat(64)), 64)

  // Returning to an earlier persona restores its own memory and establishes a new replay boundary.
  const switchConfig = { dataDir: dir, activePersona: 'A', persona: 'A的正文', personaRevision: 0 }
  const personaLong = createLongMemory({ file: path.join(dir, 'persona-long.json'), logger, llm: {} })
  const change = name => activatePersona({ name, content: name + '的正文', config: switchConfig, memory, longMemory: personaLong, persist() {} })
  change('B'); memory.push('g2', 'user', 'B的消息'); memory.flush()
  change('A')
  assert.equal(memory.get('g2').length, 0)
  change('B')
  assert.equal(memory.get('g2')[0].content, 'B的消息')
  assert.ok(memory.cutoff('g2') >= Math.floor(Date.now() / 1000) * 1000)
  console.log('dev合并安全检查通过：二次压缩手动保护、备份唯一命名/保留、启动前还原、打标格式/编辑保护、人格隔离与相似图在途取消。')
} finally {
  for (const store of stores) if (store.timer) clearTimeout(store.timer)
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  rmSync(root, { recursive: true, force: true })
}
