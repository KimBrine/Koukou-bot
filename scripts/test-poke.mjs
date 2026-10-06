import { loadPokeReplies, createPokeReplier } from '../src/pokeReplies.js'

// 模拟 logger
const logger = { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) }

const lines = loadPokeReplies(process.cwd(), logger)
console.log(`载入 ${lines.length} 条回复语\n`)

const replier = createPokeReplier(lines)
console.log('=== 随机抽取 12 次（带名字替换，检查是否连续重复）===')
const seen = []
for (let i = 0; i < 12; i++) {
  const r = replier(i % 2 === 0 ? '落叶' : '口口盐')
  const dup = seen.length && seen[seen.length - 1] === r ? ' ← 连续重复!' : ''
  seen.push(r)
  console.log(` ${i + 1}. ${r}${dup}`)
}

console.log('\n=== 无名字时的替换 ===')
console.log(' ' + createPokeReplier(['{name}你干嘛呀！人家又不是小猫咪'])(undefined))
console.log(' ' + createPokeReplier(['{name}你干嘛呀！人家又不是小猫咪'])(''))
