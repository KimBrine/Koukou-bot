import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ITEMS = [
  'memory.json', 'memory.json.reset.json',
  'long-memory.json', 'long-memory.json.state.json',
  'chat-settings.json', 'custom-commands.json',
  'vision-providers.json', 'command-center.json',
  'supervisor-state.json', 'personas', 'stickers',
]

/** 把 data 目录里"值得留"的东西打包到 data/backups/<时间戳>/，默认保留 7 份。 */
export function createBackup({ config, logger, now = () => Date.now() }) {
  const root = path.join(config.dataDir, 'backups')
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = () => {
    const d = new Date(now())
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  }
  function list() {
    if (!existsSync(root)) return []
    const out = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(root, entry.name)
      let size = 0
      try {
        const walk = (dir) => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name)
            if (e.isDirectory()) walk(p)
            else { try { size += statSync(p).size } catch {} }
          }
        }
        walk(full)
      } catch {}
      out.push({ name: entry.name, size, dir: full })
    }
    return out.sort((a, b) => b.name.localeCompare(a.name))
  }
  function lastBackupAt() {
    const first = list()[0]
    if (!first) return 0
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(first.name)
    if (!m) return 0
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
  }
  function run({ reason = 'manual', keep = 7 } = {}) {
    const dir = path.join(root, stamp())
    mkdirSync(dir, { recursive: true })
    let copied = 0
    for (const item of ITEMS) {
      const src = path.join(config.dataDir, item)
      if (!existsSync(src)) continue
      try { cpSync(src, path.join(dir, item), { recursive: true }); copied++ } catch (err) { logger?.warn?.('[备份] ' + item + ' 失败：' + err.message) }
    }
    try { writeFileSync(path.join(dir, 'backup.json'), JSON.stringify({ at: now(), reason, items: copied }, null, 2)) } catch {}
    const all = list()
    for (const old of all.slice(keep)) {
      try { rmSync(old.dir, { recursive: true, force: true }) } catch {}
    }
    logger?.info?.('[备份] 完成：' + path.basename(dir) + '（' + copied + ' 项，保留 ' + Math.min(all.length, keep) + ' 份）')
    return { name: path.basename(dir), copied, dir }
  }
  return { run, list, lastBackupAt, root }
}
