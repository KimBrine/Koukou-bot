import assert from 'node:assert/strict'
import { planReply, shapeReply } from '../src/replyShape.js'

// 默认：完全跟随对方长度（上游行为）
const short = planReply({ incomingLen: 3, maxLines: 3, lineMaxChars: 40, rand: () => 0.5 })
assert.equal(short.budget, 11, '3 字问题 → 11 字预算（上游默认）')

// 最小预算：短问题也给足空间
const floored = planReply({ incomingLen: 3, maxLines: 3, lineMaxChars: 300, minBudget: 120, rand: () => 0.5 })
assert.equal(floored.budget, 120, '设了最小预算就按最小预算')

// 不设最小预算时，长消息仍按对方长度
const long = planReply({ incomingLen: 100, maxLines: 8, lineMaxChars: 300, rand: () => 0.5 })
assert.ok(long.budget > 100 && long.budget <= 8 * 300, '长消息预算跟随并受上限约束')

// 最小预算不会突破单行上限太多（perLineCap 仍受 lineMaxChars 约束）
const capped = planReply({ incomingLen: 3, maxLines: 1, lineMaxChars: 40, minBudget: 300, rand: () => 0.5 })
assert.equal(capped.perLineCap <= 40, true, '单行上限仍然生效')

// 解题模式
const q = planReply({ incomingLen: 3, maxLines: 8, lineMaxChars: 300, longMode: true, rand: () => 0.5 })
assert.equal(q.budget, 2400, '解题模式用满预算')

// 实际裁剪：12 字回复在 11 字预算下会被截断；最小预算 30 时保留完整
const text = '夜璃呀，希希你连我都不认识了吗'
assert.ok(shapeReply('这是一句非常非常长的回复'.repeat(6), short).join('').includes('…'), '超过单行上限才会截断')
assert.equal(shapeReply(text, short).join('').includes('…'), false, '单行不再被最小预算二次截断')
assert.equal(shapeReply(text, floored).join('').includes('…'), false, '120 字预算下 33 字回复完整保留')

// 最小预算下允许最多 maxLines 条，模型自己的分段会保留
const raw = '第一段内容。\n第二段内容。\n第三段内容。'
const three = planReply({ incomingLen: 5, maxLines: 3, lineMaxChars: 300, minBudget: 120, rand: () => 0.5 })
assert.equal(three.lines, 3, '最小预算时允许分三条')
assert.equal(shapeReply(raw, three).length, 3, '模型的三段会保留成三条')
const two = planReply({ incomingLen: 5, maxLines: 2, lineMaxChars: 300, minBudget: 120, rand: () => 0.5 })
assert.equal(shapeReply(raw, two).length, 2, '上限 2 时最多两条')
const noFloor = planReply({ incomingLen: 5, maxLines: 3, lineMaxChars: 300, minBudget: 0, rand: () => 0.5 })
assert.equal(noFloor.lines, 1, '不设最小预算时仍按对方长度（上游默认）')

console.log('回复预算检查通过：默认跟随 / 最小预算 / 单行上限 / 解题模式 / 实际裁剪。')
