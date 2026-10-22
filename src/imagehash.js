import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 用系统自带的 System.Drawing 算 64 位 dHash，缓存到 data/sticker-hashes.json。 */
export function createImageHasher({ config, logger }) {
  const cacheFile = path.join(config.dataDir, 'sticker-hashes.json')
  let cache = {}
  try { if (existsSync(cacheFile)) cache = JSON.parse(readFileSync(cacheFile, 'utf8')) || {} } catch { cache = {} }
  const save = () => { try { writeFileSync(cacheFile, JSON.stringify(cache)) } catch (err) { logger?.warn?.('相似图缓存保存失败：' + err.message) } }

  const supported = process.platform === 'win32'
  const key = file => path.resolve(file)
  function hashFiles(files) {
    if (!supported) return Promise.resolve()
    const todo = files.filter((file) => {
      if (!existsSync(file)) return false
      const cached = cache[key(file)]
      if (!cached) return true
      try { const st = statSync(file); return cached.mtime !== st.mtimeMs || cached.size !== st.size } catch { return true }
    })
    if (!todo.length) return Promise.resolve()
    return new Promise((resolve) => {
      let dir
      try { dir = mkdtempSync(path.join(os.tmpdir(), 'stk-hash-')) } catch { return resolve() }
      const cleanup = () => { if (dir && path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('stk-hash-')) rmSync(dir,{recursive:true,force:true}) }
      const listFile = path.join(dir, 'list.json')
      try { writeFileSync(listFile, JSON.stringify(todo)) } catch { cleanup(); return resolve() }
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(config.rootDir, 'scripts', 'sticker-hash.ps1'), listFile], { timeout: 180000, windowsHide: true }, (err, stdout) => {
        if (err) { cleanup(); logger?.warn?.('图片指纹计算失败：' + err.message); return resolve() }
        try {
          const rows = JSON.parse(stdout || '[]')
          for (const row of Array.isArray(rows) ? rows : [rows]) {
            if (!row || !row.file || !row.hash) continue
            try { const st = statSync(row.file); cache[key(row.file)] = { hash: row.hash, mtime: st.mtimeMs, size: st.size } } catch {}
          }
          save()
        } catch (parseErr) { logger?.warn?.('图片指纹解析失败：' + parseErr.message) }
        cleanup(); resolve()
      })
    })
  }

  function distance(a, b) {
    if (!a || !b || a.length !== b.length) return 64
    let d = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d += 1
    return d
  }
  function hashOf(item, dir) { const file=item?.file; const value=file && (path.isAbsolute(file)?key(file):dir?key(path.join(dir,file)):null); return value?cache[value]?.hash||null:null }
  function forget(file){delete cache[key(file)];save()}
  return { hashFiles, distance, hashOf, forget, cache, supported }
}
