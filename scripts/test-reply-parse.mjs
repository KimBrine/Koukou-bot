import { parseMessage } from '../src/cq.js'

console.log('=== 1. 数组格式：引用一条消息 + @机器人 ===')
const arr = [
  { type: 'reply', data: { id: '745123456789' } },
  { type: 'at', data: { qq: '3883059067' } },
  { type: 'text', data: { text: ' 你怎么看' } },
]
const r1 = parseMessage(arr, '3883059067')
console.log(' text     =', JSON.stringify(r1.text))
console.log(' atBot    =', r1.atBot)
console.log(' replyId  =', JSON.stringify(r1.replyId))

console.log('\n=== 2. CQ 码文本格式：引用 + @ ===')
const cq = '[CQ:reply,id=12345][CQ:at,qq=3883059067] 这个表情包什么意思'
const r2 = parseMessage(cq, '3883059067')
console.log(' text     =', JSON.stringify(r2.text))
console.log(' atBot    =', r2.atBot)
console.log(' replyId  =', JSON.stringify(r2.replyId))

console.log('\n=== 3. 引用消息里带图片 ===')
const arr2 = [
  { type: 'reply', data: { id: '999' } },
  { type: 'at', data: { qq: '3883059067' } },
  { type: 'text', data: { text: ' 这张图是啥' } },
]
const r3 = parseMessage(arr2, '3883059067')
console.log(' replyId  =', JSON.stringify(r3.replyId), ' images =', r3.images.length)

console.log('\n=== 4. 普通消息不应有 replyId ===')
const r4 = parseMessage('@机器人 你好', '3883059067')
console.log(' text =', JSON.stringify(r4.text), ' replyId =', JSON.stringify(r4.replyId))
