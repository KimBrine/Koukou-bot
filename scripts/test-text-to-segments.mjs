import { textToSegments } from '../src/qqFace.js'

const cases = [
  '普通文字',
  '[表情:害羞]',
  '好耶[表情:笑哭]！',
  '前面[表情:doge]后面[表情:爱心]结尾',
  '[表情:不存在的表情]测试',          // 未收录 → 直接丢弃
  '[CQ:face,id=6]模型直接写了CQ码',   // 兼容模型直写 CQ 码
  '[表情:害羞][表情:害羞]',            // 连续两个表情
]

for (const c of cases) {
  const segs = textToSegments(c)
  const desc = segs.map((s) => (s.type === 'text' ? `text(${JSON.stringify(s.data.text)})` : `face(id=${s.data.id})`)).join(' + ')
  console.log(`${JSON.stringify(c)}\n   → ${desc || '（空）'}\n`)
}
