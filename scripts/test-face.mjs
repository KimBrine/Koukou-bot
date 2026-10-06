import { parseMessage } from '../src/cq.js'
import { faceName, renderFacesToCq, FACE_IDS } from '../src/qqFace.js'

console.log('=== 1. 解析经典小黄脸（只有 id）===')
const classic = [
  { type: 'text', data: { text: '哈哈哈' } },
  { type: 'face', data: { id: '13', raw: { faceIndex: 13, faceText: null } } },
  { type: 'face', data: { id: '182', raw: { faceIndex: 182, faceText: null } } },
]
console.log(' →', JSON.stringify(parseMessage(classic, '200000014').text))

console.log('\n=== 2. 解析新版表情（NapCat 带 faceText）===')
const modern = [
  { type: 'face', data: { id: '489', raw: { faceIndex: 489, faceText: '/知识增加' } } },
  { type: 'text', data: { text: '你说得对' } },
  { type: 'face', data: { id: '476', raw: { faceIndex: 476, faceText: '/不是吧' } } },
]
console.log(' →', JSON.stringify(parseMessage(modern, '200000014').text))

console.log('\n=== 3. 解析未知表情 id ===')
const unknown = [{ type: 'face', data: { id: '9999', raw: null } }]
console.log(' →', JSON.stringify(parseMessage(unknown, '200000014').text))

console.log('\n=== 4. CQ 码文本格式 ===')
console.log(' →', JSON.stringify(parseMessage('早上好[CQ:face,id=14] 今天也要加油[CQ:face,id=149]', '200000014').text))

console.log('\n=== 5. 出站：模型回复转成 QQ 表情 CQ 码 ===')
const replies = [
  '好耶[表情:笑哭]',
  '人家才没有[doge]呢',           // 裸方括号不转换，避免误伤
  '[表情:微笑]你好呀',
  '[表情:不存在的表情]测试',
]
for (const r of replies) console.log(` ${JSON.stringify(r)} → ${JSON.stringify(renderFacesToCq(r))}`)

console.log('\n=== 6. 对照表规模 ===')
console.log(` 已收录 ${Object.keys(FACE_IDS).length} 个名称，微笑=id${FACE_IDS.get('微笑')}，doge=id${FACE_IDS.get('doge')}`)
console.log(` faceName(13)="${faceName('13')}"  faceName(489, '/知识增加')="${faceName('489', '/知识增加')}"`)
