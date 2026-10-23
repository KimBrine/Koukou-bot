import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './stateFile.js'

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
export function createPythonPlugins({ config, logger, pythonPath = 'python', timeoutMs = 20000, execFileImpl = execFile }) {
  const dir = path.join(config.rootDir, 'plugins', 'python')
  const list = () => {
    if (!existsSync(dir)) return []
    const disabled = readDisabled()
    const names = getSettings().names
    const out = []
    for (const file of readdirSync(dir).filter((f) => NAME_RE.test(f)).sort()) {
      const full = path.join(dir, file)
      let text = ''
      try { text = readFileSync(full, 'utf8') } catch {}
      const meta = parseMeta(text, file)
      try { meta.size = statSync(full).size } catch {}
      meta.path = full
      meta.enabled = !disabled.has(meta.id)
      meta.command = names[meta.id] || meta.id
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
  async function run(name, rawArgs) {
    const id = resolveId(name)
    const file = id + '.py'
    if (!NAME_RE.test(file)) throw new Error('脚本名无效')
    const full = path.join(dir, file)
    if (!existsSync(full)) throw new Error('脚本不存在：' + file)
    if (!isEnabled(id)) throw new Error('脚本已停用：' + id + '（管理员可在控制台「指令中心 → Python 脚本」开启）')
    const args = splitArgs(rawArgs).slice(0, 20)
    // 脚本可在头部声明 # timeout-ms: N 覆盖默认 20 秒（jm 打包大文件需要更久）
    let callTimeout = timeoutMs
    try {
      const head = readFileSync(full, 'utf8').slice(0, 4096)
      const m = /^#\s*timeout-ms:\s*(\d{3,6})\s*$/mi.exec(head)
      if (m) callTimeout = Math.max(1000, Math.min(600000, Number(m[1])))
    } catch { /* 读不到就用默认 */ }
    const childEnv = {
      ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      // 打包与文件上限下发给脚本（jm.py 等），控制台改完下一次调用即生效
      KOUKOU_ARCHIVE_FORMAT: String(config.archiveFormat || 'zip'),
      KOUKOU_ARCHIVE_PASSES: String(config.archivePasses || 1),
      KOUKOU_SEVEN_ZIP: String(config.sevenZipPath || ''),
      KOUKOU_RAR: String(config.rarPath || ''),
      KOUKOU_FILE_MAX_MB: String(config.fileUploadMaxMb || 1024),
      KOUKOU_FILE_SPLIT_MB: String(config.fileSplitMb || 90),
    }
    return await new Promise((resolve) => {
      execFileImpl(pythonPath, ['-X', 'utf8', full, ...args], { cwd: dir, timeout: callTimeout, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8', env: childEnv }, (err, stdout, stderr) => {
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
  function readSettingsRaw() {
    if (!existsSync(SETTINGS_FILE)) return {}
    const value = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Python插件设置格式错误，请恢复备份')
    return value
  }
  function getSettings() {
    const data = readSettingsRaw()
    const n = Number(data.recallSeconds ?? (data.recallMinutes !== undefined ? Number(data.recallMinutes) * 60 : NaN))
    const names = data.names && typeof data.names === 'object' && !Array.isArray(data.names) ? data.names : {}
    const recallEnabled = data.recallEnabled === undefined ? true : Boolean(data.recallEnabled)
    return { recallSeconds: Number.isFinite(n) ? Math.min(7200, Math.max(5, Math.round(n))) : 300, recallEnabled, names }
  }
  function setSettings(patch) {
    const data = readSettingsRaw()
    // 兼容还没刷新页面的旧控制台：老字段是分钟
    const raw = patch && patch.recallSeconds !== undefined
      ? patch.recallSeconds
      : patch && patch.recallMinutes !== undefined ? Number(patch.recallMinutes) * 60 : undefined
    if (raw !== undefined) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 5 || n > 7200) throw new Error('撤回秒数需在 5~7200 之间（0.1~120 分钟）')
      data.recallSeconds = Math.round(n)
    }
    if (patch && patch.recallEnabled !== undefined) data.recallEnabled = Boolean(patch.recallEnabled)
    mkdirSync(dir, { recursive: true }); writeJsonAtomic(SETTINGS_FILE, data)
    return getSettings()
  }
  /** 调用名：/py <command>；默认等于文件名（不含 .py） */
  function commandOf(id) {
    const key = String(id || '').replace(/\.py$/i, '')
    return getSettings().names[key] || key
  }
  function setCommandName(id, command) {
    const key = String(id || '').replace(/\.py$/i, '')
    if (!NAME_RE.test(key + '.py')) throw new Error('脚本名无效')
    if (!existsSync(path.join(dir, key + '.py'))) throw new Error('脚本不存在：' + key + '.py')
    const cmd = String(command || '').trim().replace(/\.py$/i, '')
    if (/^(列表|list|帮助|help|指令|命令)$/i.test(cmd)) throw new Error('调用名不能使用列表或帮助保留词')
    const data = readSettingsRaw()
    const names = data.names && typeof data.names === 'object' && !Array.isArray(data.names) ? { ...data.names } : {}
    if (!cmd || cmd === key) {
      delete names[key]
    } else {
      if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,20}$/.test(cmd)) throw new Error('调用名只能用中英文、数字、下划线、短横线，1~20 个字符')
      for (const [k, v] of Object.entries(names)) if (k !== key && v === cmd) throw new Error('调用名已被 ' + k + '.py 占用')
      if (existsSync(path.join(dir, cmd + '.py'))) throw new Error('调用名不能和现有脚本文件重名')
      names[key] = cmd
    }
    data.names = names
    mkdirSync(dir, { recursive: true }); writeJsonAtomic(SETTINGS_FILE, data)
    return cmd || key
  }
  /** 把用户输入的调用名解析成实际文件名 id */
  function resolveId(name) {
    const n = String(name || '').replace(/\.py$/i, '')
    if (existsSync(path.join(dir, n + '.py'))) return n
    const names = getSettings().names
    for (const [k, v] of Object.entries(names)) if (v === n) return k
    return n
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
    if (!existsSync(DISABLED_FILE)) return new Set()
    const raw = JSON.parse(readFileSync(DISABLED_FILE, 'utf8'))
    if (!Array.isArray(raw)) throw new Error('Python插件停用设置损坏，请恢复备份')
    return new Set(raw.map(String))
  }
  function writeDisabled(set) {
    mkdirSync(dir, { recursive: true })
    writeJsonAtomic(DISABLED_FILE, [...set])
  }
  function isEnabled(name) {
    return !readDisabled().has(resolveId(name))
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
      lines.push(`▪ /py ${it.command || it.id} — ${it.name}${it.enabled === false ? '（已停用）' : ''}`)
      if (it.description) lines.push(`   ${it.description.slice(0, 60)}`)
      const cmds = Array.isArray(it.commands) ? it.commands : []
      if (cmds.length) {
        for (const c of cmds) {
          const u = /^\/py\b/i.test(c.usage) ? c.usage : `/py ${it.command || it.id} ${c.usage}`
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
  return { list, run, importScript, remove, helpText, isEnabled, setEnabled, getSettings, setSettings, readScript, commandOf, setCommandName, resolveId, dir }
}
