import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStickers, STICKER_SCENES } from '../src/stickers.js'
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

  // ---- 自动学习 ----
  const config = { stickerLearnEnabled: true, stickerLearnPerHour: 2 }
  let visionCalls = 0
  const visionLLM = {
    async describeImages() {
      visionCalls++
      return '{"name":"猫猫震惊","keywords":["震惊","什么"],"scenes":["question"]}'
    },
  }
  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => bytes,
  })
  const learner = createStickerLearner({ config, logger, stickers: lib, visionLLM, fetchImpl: fakeFetch, now: () => 1000 })

  const before = lib.count()
  const item = await learner.learnFromMessage({ images: [{ url: 'https://example.com/a.png' }], groupId: 831838803, senderName: '小明', text: '？？' })
  assert.ok(item, '应该学到一张')
  assert.equal(lib.count(), before + 1)
  assert.equal(item.origin, 'learned')
  assert.equal(item.name, '猫猫震惊')
  assert.deepEqual(item.keywords, ['震惊', '什么'])
  assert.deepEqual(item.scenes, ['question'])
  assert.match(item.source, /831838803/)
  assert.equal(visionCalls, 1)

  // 同一张重复学习：不新增（哈希去重）
  const dup = await learner.learnFromMessage({ images: [{ url: 'https://example.com/a.png' }], groupId: 831838803, senderName: '小明' })
  assert.equal(lib.count(), before + 1, '重复图片不新增')
  assert.equal(dup.name, '猫猫震惊')

  // 每小时上限（已用 2 次）
  const third = await learner.learnFromMessage({ images: [{ url: 'https://example.com/b.png' }], groupId: 831838803 })
  assert.equal(third, null, '超出每小时上限应停止学习')

  // 关闭学习后不学
  const off = createStickerLearner({ config: { ...config, stickerLearnEnabled: false }, logger, stickers: lib, visionLLM, fetchImpl: fakeFetch })
  assert.equal(await off.learnFromMessage({ images: [{ url: 'https://x/y.png' }] }), null)

  // 没有视觉模型也能学（占位名）
  const noVision = createStickerLearner({ config: { stickerLearnEnabled: true, stickerLearnPerHour: 5 }, logger, stickers: lib, visionLLM: null, fetchImpl: fakeFetch, now: () => 5000 })
  const placeholder = await noVision.learnFromMessage({ images: [{ url: 'https://x/z.png' }], groupId: 1 })
  assert.ok(placeholder)
  assert.match(placeholder.name, /群友表情/)

  // 非法图片类型直接跳过
  const badType = createStickerLearner({
    config: { stickerLearnEnabled: true, stickerLearnPerHour: 5 }, logger, stickers: lib, visionLLM,
    fetchImpl: async () => ({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => bytes }),
  })
  assert.equal(await badType.learnFromMessage({ images: [{ url: 'https://x/h.html' }] }), null)

  console.log('表情包语境与自动学习检查通过：场景匹配 / 用法学习 / 选图 / 去重 / 限流 / 关闭开关。')
} finally {
  rmSync(root, { recursive: true, force: true })
}
