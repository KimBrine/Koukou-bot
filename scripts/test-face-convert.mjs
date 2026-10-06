import { renderFacesToCq, FACE_IDS } from '../src/qqFace.js'

console.log('=== 1. 表情名 → CQ 码（出站转换）===')
const cases = [
  '[表情:害羞]',
  '[表情：害羞]   ← 全角冒号',
  '好耶[表情:笑哭]',
  '呜…[表情:doge]你干嘛',
  '[表情:不存在的表情]测试',
  '[表情:捂脸][表情:爱心]',
]
for (const c of cases) {
  console.log(`  ${JSON.stringify(c)} → ${JSON.stringify(renderFacesToCq(c))}`)
}

console.log('\n=== 2. 常见表情的 ID 映射 ===')
for (const name of ['害羞', '笑哭', 'doge', '捂脸', '爱心', '微笑', '呲牙', '白眼']) {
  console.log(`  ${name} → id ${FACE_IDS.get(name) ?? '（未收录）'}`)
}

console.log('\n=== 3. 幂等性（已转换过的文本再转一次不变）===')
const once = renderFacesToCq('好的[表情:害羞]')
const twice = renderFacesToCq(once)
console.log(`  第一次: ${JSON.stringify(once)}`)
console.log(`  第二次: ${JSON.stringify(twice)}`)
console.log(`  ${once === twice ? '✅ 幂等' : '❌ 不幂等'}`)
