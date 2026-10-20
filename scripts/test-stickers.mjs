import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStickers, extractStickerMarkers, parseDataUrl } from '../src/stickers.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-stickers-'))
const logger = { info() {}, warn() {}, error() {}, debug() {} }
try {
  // dataUrl 解析
  const parsed = parseDataUrl(PNG)
  assert.equal(parsed.mime, 'image/png')
  assert.ok(parsed.buffer.length > 0)
  assert.throws(() => parseDataUrl('data:text/plain;base64,AAAA'), /PNG/)
  assert.throws(() => parseDataUrl('不是一个图片'), /PNG/)

  const lib = createStickers({ dir: path.join(root, 'stickers'), logger })
  assert.equal(lib.count(), 0)

  // 新增
  const a = lib.add({ name: '猫猫', keywords: '猫 可爱 卖萌', dataUrl: PNG })
  assert.equal(a.duplicated, false)
  assert.equal(lib.count(), 1)
  assert.equal(a.item.name, '猫猫')
  assert.deepEqual(a.item.keywords, ['猫', '可爱', '卖萌'])
  assert.ok(existsSync(path.join(lib.dir, a.item.file)), '图片文件应落盘')

  // 重复上传同一张图：不新增
  const dup = lib.add({ name: '另一只猫', dataUrl: PNG })
  assert.equal(dup.duplicated, true)
  assert.equal(lib.count(), 1)

  // 匹配：名称 / 关键词 / 部分包含 / 找不到
  assert.equal(lib.find('猫猫').id, a.item.id)
  assert.equal(lib.find('卖萌').id, a.item.id)
  assert.equal(lib.find('猫').id, a.item.id)
  assert.equal(lib.find('狗'), null)

  // 更新
  assert.equal(lib.update(a.item.id, { name: '大橘', keywords: '橘猫 胖' }).name, '大橘')
  assert.equal(lib.find('橘猫').name, '大橘')
  assert.equal(lib.update('不存在', { name: 'x' }), null)

  const oldHash=lib.get(a.item.id).hash,oldFile=lib.get(a.item.id).file
  const replacement='data:image/png;base64,'+Buffer.concat([Buffer.from(PNG.split(',')[1],'base64'),Buffer.from('new-image')]).toString('base64')
  const edited=lib.update(a.item.id,{description:'适合安慰朋友',dataUrl:replacement})
  assert.equal(edited.id,a.item.id);assert.equal(edited.description,'适合安慰朋友')
  assert.notEqual(edited.hash,oldHash);assert.equal(edited.hash.length,64)
  assert.equal(existsSync(path.join(lib.dir,oldFile)),false)
  assert.equal(existsSync(path.join(lib.dir,edited.file)),true)
  const other=lib.add({name:'另一张',dataUrl:PNG})
  assert.throws(()=>lib.update(a.item.id,{dataUrl:PNG,name:'不能覆盖'}),/已存在/)
  assert.equal(lib.get(a.item.id).name,'大橘');lib.remove(other.item.id)
  const reboot=createStickers({dir:lib.dir,logger})
  assert.equal(reboot.get(a.item.id).hash,edited.hash);assert.equal(reboot.get(a.item.id).description,'适合安慰朋友')

  // 摘要（给模型看）
  assert.match(lib.summary(), /大橘/)
  assert.match(lib.summary(), /橘猫/)

  // 发送用的 data URL（base64://）
  assert.match(lib.dataUrlOf(lib.get(a.item.id)), /^base64:\/\//)

  // 随机
  assert.equal(lib.random().id, a.item.id)

  // 删除：文件和索引都要清掉
  const fileName = lib.get(a.item.id).file
  assert.equal(lib.remove(a.item.id), true)
  assert.equal(lib.remove(a.item.id), false)
  assert.equal(lib.count(), 0)
  assert.equal(existsSync(path.join(lib.dir, fileName)), false, '图片文件应被删除')

  const blockItem=lib.add({name:'不再收录',dataUrl:PNG}).item
  assert.equal(lib.blacklist(blockItem.id),true)
  assert.equal(lib.count(),0)
  assert.equal(existsSync(path.join(lib.dir,blockItem.file)),false)
  assert.equal(lib.dataUrlOf(blockItem),null,'在途发送也不能读取被拉黑图片')
  assert.throws(()=>lib.add({dataUrl:PNG}),/黑名单/)
  const blockedReboot=createStickers({dir:lib.dir,logger})
  assert.equal(blockedReboot.isBlocked(blockItem.hash),true)
  assert.equal(blockedReboot.blacklistEntries()[0].name,'不再收录')
  assert.throws(()=>blockedReboot.add({dataUrl:PNG,origin:'learned'}),/黑名单/)
  const editable=blockedReboot.add({dataUrl:replacement}).item
  assert.throws(()=>blockedReboot.update(editable.id,{dataUrl:PNG}),/黑名单/)
  assert.equal(blockedReboot.unblock(blockItem.hash),true)
  assert.equal(blockedReboot.add({dataUrl:PNG}).duplicated,false)

  // 标记解析
  const r1 = extractStickerMarkers('走啦\n[贴纸: 猫猫]\n明天见')
  assert.deepEqual(r1.queries, ['猫猫'])
  assert.equal(r1.text, '走啦\n\n明天见')
  const r2 = extractStickerMarkers('[贴纸：卖萌]')
  assert.deepEqual(r2.queries, ['卖萌'])
  assert.equal(r2.text, '')
  const r3 = extractStickerMarkers('没有标记的普通消息')
  assert.deepEqual(r3.queries, [])
  assert.equal(r3.text, '没有标记的普通消息')
  const r4 = extractStickerMarkers('[贴纸: 猫][贴纸: 狗]')
  assert.deepEqual(r4.queries, ['猫', '狗'])

  console.log('表情包库检查通过：解析 / 新增 / 去重 / 匹配 / 更新 / 删除 / 标记解析。')
} finally {
  rmSync(root, { recursive: true, force: true })
}
