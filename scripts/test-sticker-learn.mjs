import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStickers, STICKER_SCENES } from '../src/stickers.js'
import { createImageCache } from '../src/imageCache.js'
import { parseMessage } from '../src/cq.js'
import { createStickerLearner } from '../src/stickerLearn.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
// 1x1 PNG 只有几十字节，学习器会跳过过小的图；补到 2KB 模拟真实表情包
const bytes = Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.alloc(2048)])
const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-sticker-learn-'))
const logger = { info() {}, warn() {}, error() {}, debug() {} }
try {
  const lib = createStickers({ dir: path.join(root, 'stickers'), logger })

  // ---- 场景标签 ----
  const a = lib.add({ name: '猫猫点赞', keywords: '赞 好', scenes: ['like', 'happy'], dataUrl: PNG })
  assert.deepEqual(a.item.scenes, ['like', 'happy'])
  assert.equal(lib.find('喜欢/赞同').id, a.item.id, '场景名也能匹配')
  assert.equal(lib.update(a.item.id, { scenes: ['angry'] }).scenes[0], 'angry')
  assert.equal(lib.update(a.item.id, { scenes: ['不存在的场景'] }).scenes.length, 0, '非法场景被过滤')
  assert.ok(STICKER_SCENES.length >= 8)

  // ---- 用法学习 + 按语境挑图 ----
  lib.update(a.item.id, { scenes: ['like'] })
  lib.noteUsage(a.item.id, '今天好累啊，不想上班')
  assert.equal(lib.get(a.item.id).usage, 1)
  assert.equal(lib.get(a.item.id).lastContexts[0], '今天好累啊，不想上班')
  assert.equal(lib.pick('今天好累啊，不想上班').id, a.item.id, '相同语境应命中同一张')
  assert.equal(lib.pick('').id, a.item.id, '空语境退化为随机（库里只有一张）')

  const config = { stickerLearnEnabled: true, stickerLearnPerHour: 20, stickerLearnGroups: new Set([12345]) }
  const cache = createImageCache({ dir: path.join(root, 'cache'), logger })
  let downloads = 0, filters = 0, tags = 0, firstAccept = true, secondAccept = true
  const filterLLM = { model: 'deepseek-flash', async describeImages() { filters++; return JSON.stringify({ isSticker: firstAccept }) } }
  const tagLLM = { model: 'qwen-test', async describeImages() { tags++; return JSON.stringify({ isSticker: secondAccept, name: '猫猫震惊', keywords: ['震惊'], scenes: ['question'] }) } }
  const fetchImpl = async url => ({ ok: true, headers: { get: key => key === 'content-type' ? 'image/png' : null },
    arrayBuffer: async () => { downloads++; return Buffer.concat([bytes, Buffer.from(url)]) } })
  const learner = createStickerLearner({ config, logger, stickers: lib, filterLLM, tagLLM, imageCache: cache, fetchImpl })
  const msg = (name, groupId = 12345) => ({ groupId, images: [{ file: name, url: 'https://example.com/' + name }], text: '测试' })
  assert.equal(await learner.learnFromMessage(msg('outside', 12346)), null)
  assert.equal(downloads, 0, '未指定群不下载或调用模型；与白名单无关')
  const item = await learner.learnFromMessage(msg('meme'))
  assert.equal(item.name, '猫猫震惊'); assert.deepEqual(item.scenes, ['question'])
  assert.equal(filters, 1); assert.equal(tags, 1)
  await learner.learnFromMessage(msg('meme'))
  assert.equal(downloads, 1); assert.equal(filters, 1); assert.equal(tags, 1, '已收录图复用缓存与标签')
  lib.blacklist(item.id)
  assert.equal(await learner.learnFromMessage(msg('meme')),null)
  assert.equal(filters,1);assert.equal(tags,1,'黑名单图片不重复识别或重新入库')
  assert.equal(downloads,1,'缓存仍可复用，不必为了黑名单重复下载')
  lib.unblock(item.hash)
  firstAccept = false
  assert.equal(await learner.learnFromMessage(msg('photo')), null)
  assert.equal(tags, 1, 'Flash排除普通图片后不送Qwen')
  firstAccept = true; secondAccept = false
  assert.equal(await learner.learnFromMessage(msg('not-meme')), null)
  assert.equal(tags, 2, 'Qwen复核排除，不能入库')
  secondAccept = true
  const off = createStickerLearner({ config: { ...config, stickerLearnGroups: new Set() }, stickers: lib, filterLLM, tagLLM, fetchImpl })
  assert.equal(await off.learnFromMessage(msg('empty')), null, '默认空范围不采集')
  const noVision = createStickerLearner({ config, stickers: lib, filterLLM, tagLLM: null, fetchImpl })
  assert.equal(await noVision.learnFromMessage(msg('missing-model')), null, '缺少复核模型不收藏占位图')
  const beforePrivate=downloads
  assert.equal(await learner.learnFromMessage({...msg('private-image'),chatKey:'p99999'}),null)
  assert.equal(downloads,beforePrivate,'默认不从私聊采集')
  config.stickerLearnPrivate=true
  assert.ok(await learner.learnFromMessage({...msg('private-image'),chatKey:'p99999'}))
  config.stickerLearnPerHour = 0
  assert.equal(await learner.learnFromMessage(msg('limit')), null)
  config.stickerLearnPerHour = 20; config.stickerLearnEnabled = false
  assert.equal(await learner.learnFromMessage(msg('off')), null)
  assert.equal(parseMessage([{ type: 'image', data: { file: 'x', sub_type: 1 } }]).images[0].subType, 1)
  assert.equal(parseMessage('[CQ:image,file=x,sub_type=0]').images[0].subType, 0)
  console.log('表情包学习：指定群、两阶段筛选、图片排除、缓存、缺失模型、限流、图片类型检查通过。')

} finally {
  rmSync(root, { recursive: true, force: true })
}
