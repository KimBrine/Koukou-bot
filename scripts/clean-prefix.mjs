import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'data', 'memory.json')
const mem = JSON.parse(readFileSync(file, 'utf8'))
let cleaned = 0

for (const key of Object.keys(mem)) {
  for (const m of mem[key]) {
    if (typeof m.content !== 'string') continue
    const before = m.content
    // 去掉 [回应 xxx] / [回复 xxx] / [系统] 等内部标记（开头或中间都清）
    m.content = m.content
      .replace(/\[(回应|回复)\s*[^\]]{0,40}\]\s*/g, '')
      .replace(/^\s*\[系统[^\]]{0,40}\]\s*/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (m.content !== before) cleaned++
  }
}
writeFileSync(file, JSON.stringify(mem, null, 2))

// 复核
const check = JSON.parse(readFileSync(file, 'utf8'))
let remain = 0
for (const key of Object.keys(check)) {
  for (const m of check[key]) {
    if (typeof m.content === 'string' && /\[(回应|回复)\s/.test(m.content)) remain++
  }
}
console.log(`本次清理 ${cleaned} 条；复核后仍带前缀的条目：${remain} 条`)
for (const key of Object.keys(check)) {
  const last = check[key].slice(-2)
  console.log(`  ${key} 末尾: ${last.map((m) => `${m.role}="${m.content.slice(0, 38)}"`).join(' | ')}`)
}
