/**
 * 把 index.js 里的"系统附加说明"提示词文本提取到 src/chatAppendix.js，
 * index.js 改为调用它。用脚本精确搬运（不手抄），并打印长度做校验。
 *
 *   node scripts/extract-appendix.mjs          # 试运行，只打印预览
 *   node scripts/extract-appendix.mjs --write   # 实际写入（index.js 备份为 index.js.bak）
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexPath = path.join(ROOT, 'src', 'index.js')
const appendixPath = path.join(ROOT, 'src', 'chatAppendix.js')
const write = process.argv.includes('--write')

const src = readFileSync(indexPath, 'utf8')
if (src.includes('chatAppendix.js')) {
  console.log('index.js 已经引用 chatAppendix.js，无需重复提取。')
  process.exit(0)
}

// 源文件里 \n 是字面的两个字符（转义序列），原样搬进新模板字符串即可保持语义
const startMark = '\\n\\n（系统附加说明：'
const endMark = '当前时间：${time}。）'
const start = src.indexOf(startMark)
const end = src.indexOf(endMark)
if (start < 0 || end < 0) {
  console.error('找不到附加说明锚点，已中止（源文件未改动）。')
  process.exit(1)
}
const body = src.slice(start, end + endMark.length)
console.log(`提取到的提示词长度：${body.length} 字`)
console.log(`其中插值 ${(body.match(/\$\{/g) || []).length} 个、换行转义 ${(body.match(/\\n/g) || []).length} 个`)

const moduleSrc = `/**
 * 聊天规则（系统附加说明）：拼在 persona 之后，告诉模型该怎么说话。
 *
 * 由 scripts/extract-appendix.mjs 从 index.js 精确提取，主流程与实测脚本共用同一份文本，
 * 避免"测试用的提示词和线上跑的不是同一份"。
 */
export function buildChatAppendix({ time }) {
  return \`${body}\`
}
`

const importLine = "import { createRateLimiter } from './humanize.js'"
if (!src.includes(importLine)) {
  console.error('找不到 import 锚点，已中止（源文件未改动）。')
  process.exit(1)
}

// 1) 正文（含原收尾反引号）整体换成函数调用，并补回收尾反引号；2) 补 import
const withoutBody = src.slice(0, start) + '${buildChatAppendix({ time })}`' + src.slice(end + endMark.length + 1)
const out = withoutBody.replace(
  importLine,
  `${importLine}\nimport { buildChatAppendix } from './chatAppendix.js'`,
)

if (!out.includes('buildChatAppendix({ time })') || !out.includes("from './chatAppendix.js'")) {
  console.error('替换结果校验失败，已中止（源文件未改动）。')
  process.exit(1)
}

if (!write) {
  console.log('\n（试运行，未写入；加 --write 才会落盘）')
  console.log('--- chatAppendix.js 预览（前 300 字）---')
  console.log(moduleSrc.slice(0, 300))
  process.exit(0)
}

copyFileSync(indexPath, `${indexPath}.bak`)
writeFileSync(appendixPath, moduleSrc)
writeFileSync(indexPath, out)
console.log(`已写入 ${appendixPath}`)
console.log(`已更新 ${indexPath}（备份：index.js.bak）`)
console.log(`index.js 体积：${src.length} → ${out.length} 字（减少 ${src.length - out.length}）`)
