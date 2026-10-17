import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** 内置兜底回复语（poke-replies.txt 缺失或为空时使用） */
const DEFAULTS = ['在的，怎么啦？', '{name}，找我有什么事？', '收到你的拍一拍了。']

/** 从 poke-replies.txt 载入回复语；不可用时退回内置 */
export function loadPokeReplies(rootDir, logger, privateFile) {
  const file = privateFile && existsSync(privateFile) ? privateFile : path.join(rootDir, 'poke-replies.txt')
  if (!existsSync(file)) return DEFAULTS
  try {
    const lines = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
    if (lines.length === 0) return DEFAULTS
    logger?.info?.(`已载入 ${lines.length} 条拍一拍回复语`)
    return lines
  } catch (err) {
    logger?.warn?.(`读取 poke-replies.txt 失败，使用内置回复：${err.message}`)
    return DEFAULTS
  }
}

/** 随机挑一条（避免连续重复），并把 {name} 替换成拍的人 */
export function createPokeReplier(lines) {
  let lastIndex = -1
  return (name) => {
    const who = name && String(name).trim() ? String(name).trim() : ''
    let index = 0
    if (lines.length > 1) {
      do {
        index = Math.floor(Math.random() * lines.length)
      } while (index === lastIndex)
    }
    lastIndex = index
    return lines[index].replace(/\{name\}/g, who)
  }
}
