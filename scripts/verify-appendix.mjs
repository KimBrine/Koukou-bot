/**
 * 校验：提取到 src/chatAppendix.js 的提示词，与原 index.js.bak 里的那段逐字一致。
 * 重构安全底线——提示词哪怕差一个字，人设表现都会变。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildChatAppendix } from '../src/chatAppendix.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bak = path.join(ROOT, 'src', 'index.js.bak')
if (!existsSync(bak)) {
  console.error(`找不到备份文件 ${bak}，无法比对。`)
  process.exit(1)
}

const src = readFileSync(bak, 'utf8')
const startMark = '\\n\\n（系统附加说明：'
const endMark = '当前时间：${time}。）'
const start = src.indexOf(startMark)
const end = src.indexOf(endMark)
if (start < 0 || end < 0) {
  console.error('备份里找不到锚点。')
  process.exit(1)
}
const body = src.slice(start, end + endMark.length)
// body 是源码形态：含字面 \n 转义和 ${time} 插值，用模板字符串还原成实际文本
const original = Function('time', `return \`${body}\``)('__TIME__')
const extracted = buildChatAppendix({ time: '__TIME__' })

const same = original === extracted
console.log(`原提示词长度：${original.length}`)
console.log(`新提示词长度：${extracted.length}`)
console.log(`逐字一致：${same ? '✅ 是' : '❌ 否'}`)

if (!same) {
  for (let i = 0; i < Math.max(original.length, extracted.length); i++) {
    if (original[i] !== extracted[i]) {
      console.error(`首个差异在第 ${i} 字符：`)
      console.error(`  原：${JSON.stringify(original.slice(Math.max(0, i - 20), i + 20))}`)
      console.error(`  新：${JSON.stringify(extracted.slice(Math.max(0, i - 20), i + 20))}`)
      break
    }
  }
  process.exit(1)
}
console.log(`插值替换生效：${extracted.includes('__TIME__') ? '✅' : '❌'}`)
