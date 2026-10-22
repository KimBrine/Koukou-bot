import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value, null, 2))
}

export function writeTextAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, value, 'utf8')
    renameSync(temp, file)
  } finally { rmSync(temp, { force: true }) }
}

/**
 * 损坏的 JSON 文件先改名留档，再让调用方按空数据继续。
 * 直接按空数据跑，下一次落盘就会把原文件整个覆盖掉，用户再也找不回旧记忆。
 * 返回留档路径；改名失败返回空字符串（此时调用方仍可继续，但不会覆盖原文件的前提已失效）。
 */
export function quarantineCorrupt(file, now = Date.now) {
  try {
    const target = `${file}.corrupt-${now()}`
    renameSync(file, target)
    return target
  } catch {
    return ''
  }
}
