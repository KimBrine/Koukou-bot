import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { inspect } from 'node:util'
import path from 'node:path'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB 轮转

function formatArg(arg) {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || arg.message
  return inspect(arg, { depth: 2, breakLength: 200 })
}

export function createLogger(levelName, logFile) {
  const min = LEVELS[levelName] ?? LEVELS.info
  const write = (name, args) => {
    const time = new Date().toLocaleString('zh-CN', { hour12: false })
    const line = `[${time}] [${name}] ${args.map(formatArg).join(' ')}`
    console.log(line)
    if (!logFile) return
    try {
      if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_SIZE) {
        const old = `${logFile}.old`
        try {
          if (existsSync(old)) renameSync(old, `${old}.bak`)
          renameSync(logFile, old)
        } catch {
          /* 轮转失败就继续追加 */
        }
      }
      mkdirSync(path.dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${line}\n`)
    } catch {
      /* 文件日志失败不影响运行 */
    }
  }
  return {
    debug: (...args) => { if (min <= LEVELS.debug) write('DEBUG', args) },
    info: (...args) => { if (min <= LEVELS.info) write('INFO', args) },
    warn: (...args) => { if (min <= LEVELS.warn) write('WARN', args) },
    error: (...args) => { if (min <= LEVELS.error) write('ERROR', args) },
  }
}
