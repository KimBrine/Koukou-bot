import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

/**
 * 打包：给 /发文件、Python 插件结果和 jm 打包共用。
 *
 * 格式 zip / 7z 都由 7-Zip 生成（7z 也能写 zip）；没装 7-Zip 时 zip 退回
 * PowerShell 的 Compress-Archive。passes 是"压缩次数"：第 2 次起把上一次的
 * 压缩包再压一遍，得到 name.2.zip 这种嵌套包（次数可配 1~5，默认 1）。
 */
export const ARCHIVE_FORMATS = ['zip', '7z']
const DEFAULT_7Z = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  'D:\\7-Zip\\7z.exe',
  '/usr/bin/7z',
  '/usr/bin/7zz',
  '/usr/local/bin/7z',
  '/opt/homebrew/bin/7z',
]

export function normalizeFormat(value) {
  const text = String(value || '').trim().toLowerCase()
  return ARCHIVE_FORMATS.includes(text) ? text : 'zip'
}

export function normalizePasses(value) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1
}

export function findSevenZip({ sevenZipPath = '', candidates = [] } = {}) {
  const list = [sevenZipPath, process.env.SEVEN_ZIP_PATH, ...candidates, ...DEFAULT_7Z].filter(Boolean)
  for (const file of list) {
    try { if (existsSync(file)) return file } catch { /* ignore */ }
  }
  return ''
}

export function createArchive({ sevenZipPath = '', candidates = [], logger = null } = {}) {
  const exe = findSevenZip({ sevenZipPath, candidates })

  function runSeven(exePath, args, cwd) {
    const r = spawnSync(exePath, args, { cwd, encoding: 'utf8', windowsHide: true })
    if (r.error) throw new Error('7-Zip 启动失败：' + r.error.message)
    if (r.status !== 0) {
      const detail = String(r.stderr || r.stdout || '').trim().split(/\r?\n/).pop() || `退出码 ${r.status}`
      throw new Error('7-Zip 打包失败：' + detail.slice(0, 200))
    }
  }

  function runPowerShellZip(sourcePath, outPath) {
    const ps = `Compress-Archive -LiteralPath '${String(sourcePath).replace(/'/g, "''")}' -DestinationPath '${String(outPath).replace(/'/g, "''")}' -Force`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true })
    if (r.error || r.status !== 0) throw new Error('压缩失败（没装 7-Zip 且 Compress-Archive 也不可用）：' + String(r.stderr || r.error?.message || '').trim().slice(0, 200))
  }

  function packOnce(sourcePath, outPath, format) {
    const isDir = statSync(sourcePath).isDirectory()
    if (exe) {
      const parent = path.dirname(sourcePath)
      const args = ['a', '-t' + format, '-mx=9', '-y', outPath, path.basename(sourcePath)]
      if (isDir) args.push('-r')
      runSeven(exe, args, parent)
      return
    }
    if (format === '7z') throw new Error('没有找到 7-Zip，无法生成 7z 压缩包（可设置 SEVEN_ZIP_PATH）')
    runPowerShellZip(sourcePath, outPath)
  }

  /**
   * @returns {{file:string, name:string, dir:string, cleanup:()=>void, format:string, passes:number}}
   */
  function pack(sourcePath, { format = 'zip', passes = 1, outDir = '' } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    if (!existsSync(source)) throw new Error('要打包的路径不存在：' + source)
    const fmt = normalizeFormat(format)
    const times = normalizePasses(passes)
    const dir = outDir || path.join(os.tmpdir(), 'koukou-archive-' + process.pid + '-' + randomUUID().slice(0, 8))
    mkdirSync(dir, { recursive: true })
    const base = path.basename(source).replace(/[\\/:*?"<>|]/g, '_')
    let current = source
    for (let round = 1; round <= times; round++) {
      const suffix = round === 1 ? '' : '.' + round
      const out = path.join(dir, `${base}${suffix}.${fmt}`)
      packOnce(current, out, fmt)
      current = out
    }
    return {
      file: current,
      name: path.basename(current),
      dir,
      format: fmt,
      passes: times,
      cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } },
    }
  }

  return { pack, sevenZipPath: exe, available: Boolean(exe) }
}

/** 打包失败时的友好说明（控制台/群里直接可读） */
export function archiveErrorHint(err) {
  const text = String(err?.message || err || '')
  if (/没有找到 7-Zip/.test(text)) return '这台机器没装 7-Zip，只能打 zip；要 7z 请安装 7-Zip 或设置 SEVEN_ZIP_PATH'
  return text
}
