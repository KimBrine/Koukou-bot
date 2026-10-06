/**
 * 把旧实例的数据按会话键并入新实例 —— 只在"退役旧号"时用一次。
 *
 *   node scripts/merge-instance-data.mjs <旧data目录> <新data目录> [只并入的会话key...]
 *
 * 语义：**只并入指定的会话键**，不碰新实例的其他数据（新实例的三个群记忆更新，
 * 不能拿旧的覆盖）。不指定 key 就只报告差异，不做任何写入。
 *
 * 注意：新实例必须**先停掉**再跑 —— 它的记忆在内存里，运行中会把我写的文件覆盖掉。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const [fromDir, toDir, ...keys] = process.argv.slice(2)
if (!fromDir || !toDir) {
  console.error('用法: node scripts/merge-instance-data.mjs <旧data目录> <新data目录> [key...]')
  process.exit(1)
}

const readJson = (p, fb) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb
  } catch {
    return fb
  }
}

const memFrom = readJson(path.join(fromDir, 'memory.json'), {})
const memTo = readJson(path.join(toDir, 'memory.json'), {})
const lmFrom = readJson(path.join(fromDir, 'long-memory.json'), {})
const lmTo = readJson(path.join(toDir, 'long-memory.json'), {})

console.log('=== 差异总览（键: 旧条数 → 新条数）===')
const allKeys = new Set([...Object.keys(memFrom), ...Object.keys(memTo)])
for (const k of [...allKeys].sort()) {
  const a = Array.isArray(memFrom[k]) ? memFrom[k].length : 0
  const b = Array.isArray(memTo[k]) ? memTo[k].length : 0
  const mark = keys.includes(k) ? '  ← 将并入' : ''
  console.log(`  ${k.padEnd(16)} ${String(a).padStart(3)} → ${String(b).padStart(3)}${mark}`)
}

if (keys.length === 0) {
  console.log('\n未指定要并入的 key，只报告不写入。')
  process.exit(0)
}

let changed = 0
for (const k of keys) {
  if (!memFrom[k]) {
    console.log(`\n跳过 ${k}：旧实例里没有这个键`)
    continue
  }
  const before = Array.isArray(memTo[k]) ? memTo[k].length : 0
  memTo[k] = memFrom[k]
  console.log(`\nmemory.json  ${k}: ${before} 条 → ${memTo[k].length} 条`)
  if (lmFrom[k]) {
    const oldLen = lmTo[k]?.summary?.length ?? 0
    lmTo[k] = lmFrom[k]
    console.log(`long-memory   ${k}: 摘要 ${oldLen} 字 → ${lmTo[k].summary?.length ?? 0} 字`)
  }
  changed++
}
writeFileSync(path.join(toDir, 'memory.json'), JSON.stringify(memTo))
writeFileSync(path.join(toDir, 'long-memory.json'), JSON.stringify(lmTo))
console.log(`\n完成：并入 ${changed} 个会话键`)
