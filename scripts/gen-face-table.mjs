import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = process.argv[2]
if (!src) throw new Error('用法：node scripts/gen-face-table.mjs <NapCat 的 qface-*.js 路径>')
const raw = readFileSync(src, 'utf8')

// 结构：{"QSid":"179","QDes":"/doge","IQLid":"149",...}
const re = /\{"QSid":"(\d+)","QDes":"([^"]*)"/g
const map = new Map()
let m
while ((m = re.exec(raw)) !== null) {
  const id = Number(m[1])
  const name = m[2].replace(/^\//, '').trim()
  if (!Number.isFinite(id) || !name) continue
  if (map.has(id)) continue // 同 id 取首个
  map.set(id, name)
}
console.log(`从 NapCat 提取到 ${map.size} 个表情`)

// 抽样检查几个关键表情
for (const id of [6, 13, 14, 22, 66, 146, 149, 179, 199]) {
  console.log(`  id ${String(id).padStart(3)} → ${map.get(id) ?? '（无）'}`)
}

// 生成 qqFace.js
const entries = [...map.entries()].sort((a, b) => a[0] - b[0])
const lines = []
for (let i = 0; i < entries.length; i += 8) {
  lines.push('  ' + entries.slice(i, i + 8).map(([id, name]) => `${id}: '${name.replace(/'/g, "\\'")}'`).join(', ') + ',')
}

const content = `/**
 * QQ 表情（小黄脸 / face 段）ID ↔ 名称对照。
 *
 * 数据来源：NapCat 自带的官方表情表（napcat/static/assets/qface-*.js，字段 QSid 即 CQ 码里的 id），
 * 由 scripts/gen-face-table.mjs 自动生成，共 ${entries.length} 个表情——不要再手写，手写容易张冠李戴。
 *
 * - 入站：cq.js 用它把 [CQ:face,id=13] 或 {type:'face',data:{id:'13'}} 变成可读名称
 *   （NapCat 对较新的表情会直接给 raw.faceText，优先用它）
 * - 出站：发送层（onebot.js）把模型写的「[表情:微笑]」转换成 [CQ:face,id=14]
 */

export const FACE_NAMES = {
${lines.join('\n')}
}

/** 名称 → ID（出站用）；同名取较小 ID */
export const FACE_IDS = (() => {
  const map = new Map()
  for (const [id, name] of Object.entries(FACE_NAMES)) {
    if (!map.has(name)) map.set(name, Number(id))
  }
  return map
})()

/** 根据 face ID / NapCat raw 信息得到可读名称；未知返回 '' */
export function faceName(id, rawText) {
  if (rawText) {
    const cleaned = String(rawText).replace(/^\\//, '').trim()
    if (cleaned) return cleaned
  }
  const key = Number(id)
  if (Number.isFinite(key) && FACE_NAMES[key]) return FACE_NAMES[key]
  return ''
}

/** 把模型回复里的「[表情:微笑]」转成 QQ 可渲染的 CQ 码；未收录的名称直接丢弃（不留下方括号垃圾） */
export function renderFacesToCq(text) {
  return String(text ?? '').replace(/\\[表情[:：]\\s*([^\\[\\]]{1,12})\\]/g, (whole, name) => {
    const id = FACE_IDS.get(String(name).trim())
    return id === undefined ? '' : \`[CQ:face,id=\${id}]\`
  })
}
`

writeFileSync(path.join(root, 'src', 'qqFace.js'), content)
console.log(`\n✅ 已生成 src/qqFace.js（${entries.length} 个表情，名称 → ID 反查表已重建）`)
