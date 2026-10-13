// 本地模拟关联判定，不访问 QQ、图片网络或模型。
import assert from 'node:assert/strict'
import { selectRelevantSummaryReferences, summaryForwardPreview } from '../src/summaryReferenceSelection.js'
import { prepareSummaryReferences } from '../src/summaryReferences.js'
import { parseMessage } from '../src/cq.js'
import { mergeRecords } from '../src/dailySummary.js'
import { computeSummaryStats } from '../src/summaryStats.js'

const forward = (id, preview = '') => ({ type: 'forward', data: { id, ...(preview ? { preview } : {}) } })
const card = (id, time = 1000, preview = '') => ({ id, time, userId: '1', name: '甲', text: '[合并聊天记录]', forwards: [forward(id, preview)] })
const talk = (id, text, time = 1010, replyId = '') => ({ id, time, userId: '2', name: '乙', text, replyId })
const choose = records => selectRelevantSummaryReferences(records).map(item => item.record.id)
const logger = { info() {}, warn() {}, error() {} }
let passed = 0
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }

await check('无关联卡片和纯转发均跳过，附近有人聊天本身不是关联依据', async () => {
  const records = [card('a'), talk('b', '迎新晚会门票开始发放'), talk('c', '领取门票需要带校园卡')]
  assert.deepEqual(choose(records), [])
  assert.deepEqual(choose([card('a')]), [])
  let fetches = 0, downloads = 0, calls = 0
  const result = await prepareSummaryReferences({ records, logger, onebot: { getForwardMsg() { fetches++ } },
    loadImage() { downloads++ }, visionLLM: { describeImages() { calls++ } } })
  assert.equal(result.text, ''); assert.equal(result.eligible, 0); assert.equal(result.skippedUnrelated, 1)
  assert.equal(fetches + downloads + calls, 0); assert.equal(result.incomplete, false)
})
await check('明确引用可定位无摘要卡片，较晚引用也有效；引用其他人不会误选', () => {
  assert.deepEqual(choose([card('a'), talk('b', '这个通知的截止日期要改一下', 3000, 'a')]), ['a'])
  assert.deepEqual(choose([card('a'), talk('b', '晚会门票如何领取'), talk('c', '领取门票需要校园卡', 1020, 'b')]), [])
  assert.deepEqual(choose([card('a'), talk('b', '[表情:赞]', 1010, 'a')]), [])
})
await check('有限回复链可关联原始卡片，循环不能无限递归', () => {
  assert.deepEqual(choose([card('a'), talk('b', '好的', 1010, 'a'), talk('c', '通知里要求提交报名表', 1020, 'b')]), ['a'])
  assert.deepEqual(choose([card('a'), talk('b', '普通报名讨论', 1010, 'c'), talk('c', '普通报名讨论', 1020, 'b')]), [])
})
await check('摘要与多条附近讨论吻合才读取；单个泛词、远处同题和一次提词不选', () => {
  const source = card('a', 1000, '迎新晚会门票领取安排')
  assert.deepEqual(choose([source, talk('b', '迎新晚会门票需要提前领取'), talk('c', '晚会门票领取要带学生证')]), ['a'])
  assert.deepEqual(choose([source, talk('b', '迎新晚会门票领取', 5000), talk('c', '晚会门票需要领取', 5010)]), [])
  assert.deepEqual(choose([source, talk('b', '迎新晚会门票领取')]), [])
  assert.deepEqual(choose([card('a', 1000, '报名'), talk('b', '报名需要学生证'), talk('c', '报名准备校园卡')]), [])
})
await check('外层说明可用于关联，模糊指代只关联最近一张先前卡片', () => {
  const source = { ...card('a'), text: '迎新晚会门票领取安排 [合并聊天记录]' }
  assert.deepEqual(choose([source, talk('b', '迎新晚会门票如何领取'), talk('c', '领取晚会门票要带学生证')]), ['a'])
  assert.deepEqual(choose([card('a', 1000), card('b', 1005), talk('c', '刚发的记录里面说截止日期有调整'), talk('d', '报名时间需要重新确认', 1020)]), ['b'])
  assert.deepEqual(choose([card('a', 1000), card('b', 1000), talk('c', '刚发的记录里面说截止日期有调整'), talk('d', '报名时间需要重新确认', 1020)]), [], '同秒多张卡片无法确认指代时不猜测')
})
await check('例行指令与模板不作为关联讨论；缺失时间不靠相邻顺序猜测', () => {
  assert.deepEqual(choose([card('a', 1000, '今日猪猪'), talk('b', '/今日猪猪'), talk('c', '/我的猪圈')]), [])
  assert.deepEqual(choose([card('a', 0, '迎新晚会门票'), talk('b', '迎新晚会门票领取'), talk('c', '迎新晚会门票领取')]), [])
})
await check('JSON卡片已有摘要保留且有界，CQ和数组形式一致，不将摘要当作外层发言', () => {
  const json = JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: 'a', news: [{ text: '甲：迎新晚会门票领取安排' }], summary: '查看转发消息' } } })
  const escaped = json.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/,/g, '&#44;')
  for (const raw of [[{ type: 'json', data: { data: json } }], `[CQ:json,data=${escaped}]`]) {
    const parsed = parseMessage(raw)
    assert.equal(parsed.text, '[合并聊天记录]'); assert.match(parsed.forwards[0].data.preview, /晚会门票/)
    assert.deepEqual(choose([{ ...card('a'), forwards: parsed.forwards }, talk('b', '迎新晚会门票领取'), talk('c', '晚会门票领取要带学生证')]), ['a'])
  }
  const huge = parseMessage([{ type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: 'x', news: Array.from({ length: 100 }, () => ({ text: '资料'.repeat(1000) })) } } }) } }])
  assert.ok(huge.forwards[0].data.preview.length <= 600)
})
await check('首层内嵌文字只作小摘要，不递归嵌套、不读取图片、不修改记录', () => {
  const source = { ...card('a'), forwards: [{ type: 'forward', data: { content: [
    { type: 'node', data: { content: [{ type: 'text', data: { text: '迎新晚会门票领取' } }, forward('inner'), { type: 'image', data: { file: 'image' } }] } },
  ] } }] }
  const before = structuredClone(source)
  assert.match(summaryForwardPreview(source), /晚会门票/)
  assert.doesNotMatch(summaryForwardPreview(source), /inner|image/)
  assert.deepEqual(source, before)
})
await check('旧捕获的卡片仍可继承历史摘要，不覆盖最新摘要或改变消息统计', () => {
  const old = card('a'), rich = card('a', 1000, '迎新晚会门票领取安排')
  const result = mergeRecords([rich], [old], 0)
  assert.match(result[0].forwards[0].data.preview, /晚会门票/)
  assert.equal(mergeRecords([rich], [card('a', 1000, '实时新摘要')], 0)[0].forwards[0].data.preview, '实时新摘要')
  assert.deepEqual(computeSummaryStats(result), computeSummaryStats([old]))
  assert.equal(old.forwards[0].data.preview, undefined)
})
await check('相关卡片才展开嵌套与识图，明确引用优先于弱关联，预算不变', async () => {
  const weak = card('weak', 1000, '迎新晚会门票领取安排'), strong = card('strong', 1000), unrelated = card('unused', 1000)
  const records = [weak, strong, unrelated, talk('x', '迎新晚会门票领取安排'), talk('y', '晚会门票领取要带学生证'), talk('z', '截止日期需要重新核对', 1020, 'strong')]
  const before = structuredClone(records), stats = computeSummaryStats(records), reads = []; let images = 0
  const result = await prepareSummaryReferences({ records, logger, mainChars: 40000, maxCards: 1,
    onebot: { async getForwardMsg(id) { reads.push(id); return { messages: [{ sender: { nickname: '外部人物' }, message: id === 'strong'
      ? [forward('inner')] : [{ type: 'text', data: { text: '通知资料' } }, { type: 'image', data: { file: 'image' } }] }] } } },
    loadImage: async () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }),
    visionLLM: { async describeImages() { images++; return '图片通知' } } })
  assert.deepEqual(reads, ['strong', 'inner']); assert.equal(images, 1)
  assert.equal(result.eligible, 2); assert.equal(result.skippedUnrelated, 1); assert.equal(result.expanded, 1)
  assert.equal(result.incomplete, true); assert.match(result.text, /图片通知/)
  assert.deepEqual(records, before); assert.deepEqual(computeSummaryStats(records), stats)
})
console.log(`${passed} cases passed`)
