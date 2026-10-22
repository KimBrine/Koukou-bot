import { mkdirSync, renameSync, rmSync, writeFileSync, copyFileSync, constants } from 'node:fs'
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
 * 返回留档路径；留档失败则拒绝继续，防止后续空数据覆盖原件。
 */
export function quarantineCorrupt(file, now = Date.now, {preserveSource=false} = {}) {
  try {
    const target = `${file}.corrupt-${now()}`
    if(preserveSource)copyFileSync(file,target,constants.COPYFILE_EXCL)
    else renameSync(file, target)
    return target
  } catch (error) {
    const failure = new Error(`损坏文件留档失败，停止加载以避免覆盖原文件：${file}`, { cause: error })
    failure.code = 'STATE_QUARANTINE_FAILED'
    throw failure
  }
}
