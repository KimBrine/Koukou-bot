import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createStickers } from '../src/stickers.js'
import { createPersonaStickers } from '../src/personaStickers.js'
import { createStickerLearner } from '../src/stickerLearn.js'
import { createStickerSendPolicy } from '../src/stickerSend.js'
import { createAdminServer } from '../src/admin/server.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-persona-stickers-'))
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
let server
try {
  const dir = path.join(root, 'stickers')
  const legacy = createStickers({ dir })
  const original = legacy.add({ name: '旧图库', dataUrl: PNG }).item
  const config = { rootDir: root, dataDir: root, activePersona: 'A', personaRevision: 0, stickersEnabled: true,
    stickerAutoRate: 1, stickerCooldownSeconds: 60, stickerLearnEnabled: true,
    stickerLearnGroups: new Set([12345]), stickerLearnPerHour: 20 }
  const overrides = new Map(), revisions = new Map()
  const chatSettings = { get: key => ({ persona: overrides.get(key) || '' }) }
  const memory = { version: key => revisions.get(key) || 0 }
  const lib = createPersonaStickers({ dir, config, chatSettings, memory })
  const switchTo = name => { config.activePersona = name; config.personaRevision++ }
  assert.equal(lib.count(), 1)
  const tokenA = lib.scope().token
  const storeA = lib.forChat(), snap = lib.snapshot('g12345')
  switchTo('B')
  assert.equal(lib.count(), 0, '新人格不继承旧库')
  assert.equal(snap.current(), false)
  assert.equal(lib.dataUrlOf(original), null, '传入旧条目不能读另一个人格的图片')
  const b = lib.add({ name: 'B的图', dataUrl: PNG }).item
  lib.noteUsage(b.id, 'B的语境')
  assert.equal(storeA.get(original.id).usage || 0, 0)
  lib.blacklist(b.id)
  assert.equal(lib.blacklistEntries().length, 1)
  switchTo('A')
  assert.equal(lib.count(), 1)
  assert.equal(lib.blacklistEntries().length, 0, '同哈希在其他人格拉黑不影响A')
  assert.ok(lib.dataUrlOf(original))
  config.persona = '编辑了A的正文'
  assert.equal(lib.count(), 1, '编辑正文保留同名人格图库')
  const reloaded = createPersonaStickers({ dir, config, chatSettings, memory })
  switchTo('B')
  assert.equal(reloaded.count(), 0)
  assert.equal(reloaded.blacklistEntries().length, 1, '重启后保留归属与黑名单')
  overrides.set('g12345', 'A')
  assert.equal(lib.forChat('g12345').get(original.id).name, '旧图库')
  const perChat = lib.snapshot('g12345')
  overrides.set('g12345', 'B'); revisions.set('g12345', 1)
  overrides.set('g12345', 'A'); revisions.set('g12345', 2)
  assert.equal(perChat.current(), false, '会话切换再切回也不能继续旧任务')
  lib.unblock(b.hash)
  lib.add({ name: 'B的图', dataUrl: PNG })
  const event = { message_type: 'group', group_id: 12345 }
  const policy = createStickerSendPolicy({ config, stickers: lib, rand: () => 0 })
  assert.equal(policy.select(event, { text: 'A', queries: ['旧图库'] }).items[0].name, '旧图库')
  policy.begin(event)
  overrides.set('g12345', 'B')
  assert.equal(policy.select(event, { text: 'B', queries: ['旧图库'] }).items.length, 0)
  assert.equal(policy.select(event, { text: 'B', queries: ['B的图'] }).items[0].name, 'B的图', '冷却按人格分开')
  overrides.delete('g12345')

  // One delayed request plus a queued request must both stop after switching.
  switchTo('A')
  let release, started
  const entered = new Promise(r => { started = r })
  const wait = new Promise(r => { release = r })
  const learningPNG = 'data:image/png;base64,' + Buffer.alloc(2048, 7).toString('base64')
  const learner = createStickerLearner({ config, stickers: lib,
    imageCache: { load: async () => ({ part: { image_url: { url: learningPNG } } }) },
    filterLLM: { async describeImages() { started(); await wait; return '{"isSticker":true}' } },
    tagLLM: { async describeImages() { return '{"isSticker":true,"name":"延迟图"}' } } })
  const message = { groupId: 12345, images: [{}] }
  const first = learner.learnFromMessage(message)
  await entered
  const second = learner.learnFromMessage(message)
  switchTo('B'); release()
  assert.equal(await first, null); assert.equal(await second, null)
  assert.equal(lib.find('延迟图'), null)
  assert.equal(storeA.find('延迟图'), null)

  let finishSuggestion, suggestionStarted
  const suggestionEntered = new Promise(r => { suggestionStarted = r })
  const suggestionWait = new Promise(r => { finishSuggestion = r })
  const draftAdmin = createAdminServer({ config, stickers: lib, stickerTagLLM: {
    model:'test-qwen', async describeImages(){ suggestionStarted(); await suggestionWait; return JSON.stringify({isSticker:true,name:'草稿',keywords:[],description:'草稿',scenes:[]}) }
  } })
  const suggestion = draftAdmin.actions['sticker-suggest']({stickerScope:lib.scope().token,dataUrl:PNG})
  await suggestionEntered; switchTo('A'); finishSuggestion()
  await assert.rejects(suggestion, /人格已变化/)
  switchTo('B')

  let sent = [], midSend = false
  const admin = createAdminServer({ config, stickers: lib, chatSettings,
    onebot: { async sendGroup(group, content) { sent.push(content); if (midSend) switchTo('A'); return { message_id: 1 } } } })
  assert.equal((await admin.routes['GET /api/stickers']()).persona.name, 'B')
  await assert.rejects(admin.actions['sticker-add']({ stickerScope: tokenA, name: '错库', dataUrl: PNG }), /人格/)
  await assert.rejects(admin.actions['sticker-unblock']({ stickerScope: tokenA, hash: b.hash }), /人格/)
  overrides.set('g12345', 'A')
  await assert.rejects(admin.actions['sticker-send']({ stickerScope: lib.scope().token, groupId: '12345', text: '你好' }), /另一个人格/)
  assert.equal(sent.length, 0)
  overrides.delete('g12345'); midSend = true
  await assert.rejects(admin.actions['sticker-send']({ stickerScope: lib.scope().token, groupId: '12345', text: '你好' }), /人格/)
  assert.equal(sent.length, 1, '文字后切换不继续发旧图')
  server = await admin.start(0)
  const base = `http://127.0.0.1:${server.address().port}`
  const preview = await fetch(`${base}/api/sticker-file?id=${original.id}&scope=${encodeURIComponent(lib.scope().token)}`)
  assert.equal(preview.status, 200)
  const wrong = await fetch(`${base}/api/sticker-file?id=${original.id}&scope=${encodeURIComponent(tokenA)}`)
  assert.equal(wrong.status, 409, '旧页面预览不跨人格/切换版本')

  // Upload UI discards a delayed file read when the persona switches.
  let readDone, html = ''
  const elements = Object.fromEntries(['stickerUploadPanel','stkDrop','stkFile','stkChoose','stkFillAll','stkUpload'].map(k => [k, {}]))
  elements.stkDrop.classList = { add() {}, remove() {} }
  Object.defineProperty(elements.stickerUploadPanel, 'outerHTML', { set: v => { html = v } })
  const context = { window: {}, document: { getElementById: id => elements[id], querySelectorAll: () => [] },
    crypto: { randomUUID: () => 'draft' }, FileReader: class { readAsDataURL() { readDone = () => { this.result = PNG; this.onload() } } } }
  vm.createContext(context)
  vm.runInContext(readFileSync(new URL('../src/admin/stickerUpload.js', import.meta.url), 'utf8'), context)
  const ui = context.window.StickerUploadUI
  ui.setScope('A'); ui.bind({ toast() {}, api() { throw Error('不应上传') } })
  elements.stkFile.files = [{ name: 'old.png', type: 'image/png', size: 100 }]
  const reading = elements.stkFile.onchange()
  ui.setScope('B'); readDone(); await reading
  assert.equal(ui.dirty(), false)
  assert.doesNotMatch(ui.render(), /old.png/)

  writeFileSync(path.join(dir, 'persona-libraries.json'), '{"version":1,"legacyOwner":"B","legacyKey":"broken"}')
  assert.throws(() => createPersonaStickers({ dir, config }), /归属记录损坏/)
  console.log('人格图库隔离通过：旧库归属、重启、会话人格、标签/黑名单/使用记录、选图冷却、异步学习取消、控制台旧请求和上传草稿。')
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
