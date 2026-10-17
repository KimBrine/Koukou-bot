import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
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
