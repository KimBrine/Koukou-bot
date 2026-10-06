/**
 * 诊断：机器人实际发出的回复里，各类装饰符号（🍥 / 其他 emoji / 颜文字 / awa 口癖）各出现多少。
 *   node scripts/diag-tone.mjs [条数]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasDecoration, stripDecoration } from '../src/humanize.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const limit = Number(process.argv[2]) || 40

const data = JSON.parse(readFileSync(path.join(ROOT, 'data', 'memory.json'), 'utf8'))
const all = []
for (const [key, list] of Object.entries(data)) {
  for (const m of list) {
    if (m.role === 'assistant') all.push({ key, content: String(m.content ?? '') })
  }
}

const recent = all.slice(-limit)
const count = (re) => recent.filter((r) => re.test(r.content)).length

console.log(`记忆里共 ${all.length} 条机器人回复，取最近 ${recent.length} 条\n`)
console.log('各类装饰出现条数：')
console.log(`  🍥（鱼板，人设里的最爱）   : ${count(/🍥/u)}`)
console.log(`  其他 emoji                : ${count(/\p{Extended_Pictographic}/u)} 条含 emoji（含 🍥）`)
console.log(`  颜文字（括号符号组合）     : ${count(/[（(][^（）()]{0,20}[=^▽ωﾉ≧≦ΣД゜∀´ˊˋ・﹏◕‿⌒＞＜＾°◡ᴗಥஇ｡•︿⊙△▼][^（）()]{0,20}[）)]/u)}`)
console.log(`  awa / QAQ / XD 轻口癖     : ${count(/(awa|qwq|QAQ|TAT|XD|Orz)/i)}`)
console.log(`  完全纯文字（无任何装饰）   : ${recent.filter((r) => !hasDecoration(r.content)).length}`)

const emojiStat = new Map()
for (const r of recent) {
  for (const ch of r.content.match(/\p{Extended_Pictographic}/gu) ?? []) {
    emojiStat.set(ch, (emojiStat.get(ch) ?? 0) + 1)
  }
}
console.log('\nemoji 逐字符统计：')
if (emojiStat.size === 0) console.log('  （一条 emoji 都没有）')
for (const [ch, n] of [...emojiStat.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ch}  U+${ch.codePointAt(0).toString(16).toUpperCase()}  ×${n}`)
}

console.log('\n--- 最近 15 条原文 ---')
for (const r of recent.slice(-15)) {
  const tags = []
  if (/🍥/u.test(r.content)) tags.push('🍥')
  if (/\p{Extended_Pictographic}/u.test(r.content) && !/🍥/u.test(r.content)) tags.push('emoji')
  if (/(awa|qwq|QAQ|XD)/i.test(r.content)) tags.push('口癖')
  if (stripDecoration(r.content) !== r.content && !tags.length) tags.push('颜文字')
  console.log(`  [${tags.join('+') || '纯文字'}] ${JSON.stringify(r.content)}`)
}
