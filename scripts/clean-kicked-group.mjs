import { existsSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'data')
const TARGET = '200000018'

function dirSize(dir) {
  let total = 0
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = dirSize(p)
      total += sub.total
      files += sub.files
    } else {
      total += statSync(p).size
      files += 1
    }
  }
  return { total, files }
}

// 1) 每日消息归档目录
const dailyDir = path.join(dataDir, 'daily', TARGET)
if (existsSync(dailyDir)) {
  const { total, files } = dirSize(dailyDir)
  rmSync(dailyDir, { recursive: true, force: true })
  console.log(`✅ 已删除每日归档：data/daily/${TARGET}/ （${files} 个文件，${(total / 1024).toFixed(1)} KB）`)
} else {
  console.log(`— data/daily/${TARGET}/ 不存在，跳过`)
}

// 2) 上下文记忆 memory.json 里的会话
const memFile = path.join(dataDir, 'memory.json')
if (existsSync(memFile)) {
  const mem = JSON.parse(readFileSync(memFile, 'utf8'))
  const key = `g${TARGET}`
  if (mem[key]) {
    const n = mem[key].length
    delete mem[key]
    writeFileSync(memFile, JSON.stringify(mem, null, 2))
    console.log(`✅ 已从 memory.json 移除会话 ${key}（${n} 条对话）`)
  } else {
    console.log(`— memory.json 中没有 ${key}，跳过`)
  }
  console.log(`   现剩余会话：${Object.keys(mem).join(', ')}`)
}

// 3) 长期记忆 long-memory.json 里的摘要
const lmFile = path.join(dataDir, 'long-memory.json')
if (existsSync(lmFile)) {
  const lm = JSON.parse(readFileSync(lmFile, 'utf8'))
  const key = `g${TARGET}`
  if (lm[key]) {
    const chars = String(lm[key].summary || '').length
    delete lm[key]
    writeFileSync(lmFile, JSON.stringify(lm, null, 2))
    console.log(`✅ 已从 long-memory.json 移除 ${key}（摘要 ${chars} 字）`)
  } else {
    console.log(`— long-memory.json 中没有 ${key}，跳过`)
  }
  console.log(`   现剩余会话：${Object.keys(lm).join(', ') || '（空）'}`)
}

console.log('\n清理完成。')
