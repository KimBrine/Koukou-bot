import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const file = new URL('../data/memory.json', import.meta.url)
copyFileSync(file, new URL('../data/memory.json.bak', import.meta.url))

const mem = JSON.parse(readFileSync(file, 'utf8'))
let removed = 0
for (const key of Object.keys(mem)) {
  const before = mem[key].length
  mem[key] = mem[key].filter((m) => !(m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 250))
  const after = mem[key].length
  if (before !== after) {
    removed += before - after
    console.log(`${key}: 移除 ${before - after} 条超长回复（${before} → ${after}）`)
  }
}
writeFileSync(file, JSON.stringify(mem, null, 2))
console.log(`完成，共移除 ${removed} 条（已备份到 data/memory.json.bak）`)
