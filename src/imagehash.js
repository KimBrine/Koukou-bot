import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 用系统自带的 System.Drawing 算 64 位 dHash，缓存到 data/sticker-hashes.json。 */
export function createImageHasher({ config, logger }) {
  const cacheFile = path.join(config.dataDir, 'sticker-hashes.json')
  let cache = {}
  try { if (existsSync(cacheFile)) cache = JSON.parse(readFileSync(cacheFile, 'utf8')) || {} } catch { cache = {} }
  const save = () => { try { writeFileSync(cacheFile, JSON.stringify(cache)) } catch (err) { logger?.warn?.('相似图缓存保存失败：' + err.message) } }

  function hashFiles(files) {
    const todo = files.filter((file) => {
      if (!existsSync(file)) return false
      const cached = cache[path.basename(file)]
      if (!cached) return true
      try { const st = statSync(file); return cached.mtime !== st.mtimeMs || cached.size !== st.size } catch { return true }
    })
    if (!todo.length) return Promise.resolve()
    return new Promise((resolve) => {
      let dir
      try { dir = mkdtempSync(path.join(os.tmpdir(), 'stk-hash-')) } catch { return resolve() }
      const listFile = path.join(dir, 'list.json')
      try { writeFileSync(listFile, JSON.stringify(todo)) } catch { return resolve() }
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(config.rootDir, 'scripts', 'sticker-hash.ps1'), listFile], { timeout: 180000, windowsHide: true }, (err, stdout) => {
        if (err) { logger?.warn?.('图片指纹计算失败：' + err.message); return resolve() }
        try {
          const rows = JSON.parse(stdout || '[]')
          for (const row of Array.isArray(rows) ? rows : [rows]) {
            if (!row || !row.file || !row.hash) continue
            try { const st = statSync(row.file); cache[path.basename(row.file)] = { hash: row.hash, mtime: st.mtimeMs, size: st.size } } catch {}
          }
          save()
        } catch (parseErr) { logger?.warn?.('图片指纹解析失败：' + parseErr.message) }
        resolve()
      })
    })
  }

  function distance(a, b) {
    if (!a || !b || a.length !== b.length) return 64
    let d = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d += 1
    return d
  }
  function hashOf(item) { return item && cache[item.file] ? cache[item.file].hash : null }
  return { hashFiles, distance, hashOf, cache }
}
