import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const NAME_RE = /^[a-z0-9_-]{1,40}\.py$/i

function parseMeta(text, file) {
  const id = file.replace(/\.py$/i, '')
  const meta = { id, name: id, description: '', usage: '', admin: false, size: 0 }
  for (const line of String(text || '').split(/\r?\n/).slice(0, 30)) {
    const m = /^\s*#\s*(name|desc|description|usage|admin)\s*[:：]\s*(.+)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
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
    const out = []
    for (const file of readdirSync(dir).filter((f) => NAME_RE.test(f)).sort()) {
      const full = path.join(dir, file)
      let text = ''
      try { text = readFileSync(full, 'utf8') } catch {}
      const meta = parseMeta(text, file)
      try { meta.size = statSync(full).size } catch {}
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
  function remove(id) {
    const file = String(id || '').replace(/\.py$/i, '') + '.py'
    if (!NAME_RE.test(file)) throw new Error('脚本名无效')
    const full = path.join(dir, file)
    if (!existsSync(full)) throw new Error('脚本不存在')
    rmSync(full, { force: true })
    try { rmSync(full + '.bak', { force: true }) } catch {}
    return true
  }
  return { list, run, importScript, remove, dir }
}
