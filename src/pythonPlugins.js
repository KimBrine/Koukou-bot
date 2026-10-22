import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const NAME_RE = /^[a-z0-9_-]{1,40}\.py$/i

function parseMeta(text, file) {
  const id = file.replace(/\.py$/i, '')
  const meta = { id, name: id, description: '', usage: '', admin: false, size: 0, commands: [] }
  for (const line of String(text || '').split(/\r?\n/).slice(0, 30)) {
    const m = /^\s*#\s*(name|desc|description|usage|admin|cmd)\s*[:：]\s*(.+)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (key === 'cmd') {
      const [usage, desc] = m[2].split('|')
      if (usage && usage.trim()) meta.commands.push({ usage: usage.trim(), desc: (desc || '').trim() })
      continue
    }
    if (key === 'name') meta.name = m[2].trim()
    else if (key === 'usage') meta.usage = m[2].trim()
    else if (key === 'admin') meta.admin = /^(1|true|yes|是)$/i.test(m[2].trim())
    else meta.description = m[2].trim()
  }
  return meta
}

/** Python 插件：只执行 plugins/python 下的白名单脚本，参数按 argv 传，不走 shell。 */
export function createPythonPlugins({ config, logger, pythonPath = 'python', timeoutMs = 20000 }) {
  const dir = path.join(config.rootDir, 'plugins', 'python')
  const list = () => {
    if (!existsSync(dir)) return []
    const disabled = readDisabled()
    const out = []
    for (const file of readdirSync(dir).filter((f) => NAME_RE.test(f)).sort()) {
      const full = path.join(dir, file)
      let text = ''
      try { text = readFileSync(full, 'utf8') } catch {}
      const meta = parseMeta(text, file)
      try { meta.size = statSync(full).size } catch {}
      meta.enabled = !disabled.has(meta.id)
      out.push(meta)
    }
    return out
  }
  function splitArgs(raw) {
    const out = []
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g
    let m
    while ((m = re.exec(String(raw || '')))) out.push(m[1] ?? m[2] ?? m[3])
    return out
  }
  async function run(id, rawArgs) {
    const file = String(id || '').replace(/\.py$/i, '') + '.py'
    if (!NAME_RE.test(file)) throw new Error('脚本名无效')
    const full = path.join(dir, file)
    if (!existsSync(full)) throw new Error('脚本不存在：' + file)
    if (!isEnabled(id)) throw new Error('脚本已停用：' + id + '（管理员可在控制台「指令中心 → Python 脚本」开启）')
    const args = splitArgs(rawArgs).slice(0, 20)
    return await new Promise((resolve) => {
      execFile(pythonPath, [full, ...args], { cwd: dir, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({
          ok: !err, code: err?.code ?? 0, killed: err?.killed === true,
          stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(),
          ms: 0, signal: err?.signal,
        })
      })
    })
  }
  function importScript(filename, content) {
    const raw = String(filename || '')
    if (/[\\/]/.test(raw)) throw new Error('文件名不能包含路径')
    const base = path.basename(raw).toLowerCase()
    if (!NAME_RE.test(base)) throw new Error('文件名只能包含字母、数字、下划线、短横线，并以 .py 结尾')
    const text = String(content ?? '')
    if (!text.trim()) throw new Error('脚本内容为空')
    if (Buffer.byteLength(text) > 200 * 1024) throw new Error('脚本超过 200KB')
    mkdirSync(dir, { recursive: true })
    const full = path.join(dir, base)
    if (existsSync(full)) { try { writeFileSync(full + '.bak', readFileSync(full)) } catch {} }
    writeFileSync(full, text, 'utf8')
    logger?.info?.('[Python] 已导入脚本：' + base)
    const id = base.replace(/\.py$/i, '')
    return list().find((x) => x.id === id) || null
  }
  const SETTINGS_FILE = path.join(dir, 'settings.json')
  function getSettings() {
    let data = {}
    try { data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) || {} } catch {}
    const n = Number(data.recallSeconds ?? (data.recallMinutes !== undefined ? Number(data.recallMinutes) * 60 : NaN))
    return { recallSeconds: Number.isFinite(n) ? Math.min(7200, Math.max(5, Math.round(n))) : 300 }
  }
  function setSettings(patch) {
    const next = getSettings()
    if (patch && patch.recallSeconds !== undefined) {
      const n = Number(patch.recallSeconds)
      if (!Number.isFinite(n) || n < 5 || n > 7200) throw new Error('撤回秒数需在 5~7200 之间')
      next.recallSeconds = Math.round(n)
    }
    try { mkdirSync(dir, { recursive: true }); writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 1), 'utf8') } catch {}
    return next
  }
  function readScript(id) {
    const file = String(id || '').replace(/\.py$/i, '') + '.py'
    if (!NAME_RE.test(file)) throw new Error('脚本名无效')
    const full = path.join(dir, file)
    if (!existsSync(full)) throw new Error('脚本不存在：' + file)
    return readFileSync(full, 'utf8')
  }
  const DISABLED_FILE = path.join(dir, 'disabled.json')
  function readDisabled() {
    try {
      const raw = JSON.parse(readFileSync(DISABLED_FILE, 'utf8'))
      return new Set(Array.isArray(raw) ? raw.map(String) : [])
    } catch { return new Set() }
  }
  function writeDisabled(set) {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(DISABLED_FILE, JSON.stringify([...set], null, 1), 'utf8')
    } catch {}
  }
  function isEnabled(id) {
    return !readDisabled().has(String(id || '').replace(/\.py$/i, ''))
  }
  function setEnabled(id, enabled) {
    const key = String(id || '').replace(/\.py$/i, '')
    if (!NAME_RE.test(key + '.py')) throw new Error('脚本名无效')
    const set = readDisabled()
    if (enabled) set.delete(key)
    else set.add(key)
    writeDisabled(set)
    return isEnabled(key)
  }
  function remove(id) {
    const file = String(id || '').replace(/\.py$/i, '') + '.py'
    if (!NAME_RE.test(file)) throw new Error('脚本名无效')
    const full = path.join(dir, file)
    if (!existsSync(full)) throw new Error('脚本不存在')
    rmSync(full, { force: true })
    try { rmSync(full + '.bak', { force: true }) } catch {}
    return true
  }
  /** 列出已安装脚本的指令与作用，供 /py 直接查看；控制在 1400 字内，避免被截断。 */
  function helpText(limit = 1400) {
    const items = list()
    if (!items.length) {
      return '还没有 Python 脚本。\n把 .py 放进 plugins/python，或在控制台「指令中心」导入。'
    }
    const lines = [`Python 脚本 ${items.length} 个，用法：/py 脚本名 参数`, '']
    for (const it of items) {
      lines.push(`▪ /py ${it.id} — ${it.name}${it.enabled === false ? '（已停用）' : ''}`)
      if (it.description) lines.push(`   ${it.description.slice(0, 60)}`)
      const cmds = Array.isArray(it.commands) ? it.commands : []
      if (cmds.length) {
        for (const c of cmds) {
          const u = /^\/py\b/i.test(c.usage) ? c.usage : `/py ${it.id} ${c.usage}`
          lines.push(`   • ${u}${c.desc ? ' — ' + c.desc : ''}`)
          lines.push('')
        }
      } else if (it.usage) {
        lines.push(`   • ${it.usage.slice(0, 90)}`)
        lines.push('')
      } else {
        lines.push('')
      }
    }
    const text = lines.join('\n')
    return text.length > limit ? text.slice(0, limit - 12) + '\n…（已截断）' : text
  }
  return { list, run, importScript, remove, helpText, isEnabled, setEnabled, getSettings, setSettings, readScript, dir }
}
