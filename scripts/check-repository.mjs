// Inspect Git's index before a commit; never print a matching credential value.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trimEnd()
const root = git(['rev-parse', '--show-toplevel'])
const staged = process.argv.includes('--staged'), head = process.argv.includes('--head')
const paths = (head ? git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']) : git(['ls-files', '-z', ...(staged ? [] : ['--cached', '--others', '--exclude-standard'])]))
  .split('\0').filter(Boolean)
const issues = []
const secrets = new Set()
const addSecret = value => { if (typeof value === 'string' && value.length >= 8 && !/^<|^YOUR_|^EXAMPLE_|^https?:/i.test(value)) secrets.add(value) }
const configPaths = key => { try { return git(['config', '--get-all', key]).split(/\r?\n/).filter(Boolean) } catch { return [] } }
for (const file of new Set([path.join(root, '.env'), ...configPaths('koukou.privateEnvFile'), ...configPaths('koukou.privateBootFile')])) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^(?:set\s+|export\s+)?([\w]+)\s*=\s*(.*)$/i.exec(line.trim())
    if (m && /API_KEY|ACCESS_TOKEN|PASSWORD|SECRET|COOKIE|WEBUI_TOKEN/i.test(m[1])) addSecret(m[2].replace(/^['"]|['"]$/g, ''))
  }
}
const inspectJson = value => {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|api.?key|cookie/i.test(key)) addSecret(item)
    if (item && typeof item === 'object') inspectJson(item)
  }
}
for (const file of configPaths('koukou.privateJsonFile')) {
  try { inspectJson(JSON.parse(readFileSync(file, 'utf8'))) } catch {}
}
const privateFiles = configPaths('koukou.privateContentFile').filter(file => existsSync(file))
const privateTexts = privateFiles.filter(file => /\.(txt|json|md)$/i.test(file)).map(file => readFileSync(file, 'utf8').trim()).filter(s => s.length >= 40)
const privateHashes = new Set(privateFiles.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')))
const denied = /(?:^|\/)(?:data|logs|cache|node_modules|_removed|backups|work|private|vision-knowledge|training-data|reference-images)\/|^personas\/|(?:^|\/)\.env(?:$|\.(?!example$|napcat\.example$))|\.(?:log|jsonl|db|pem|key|lnk|bak)(?:$|[.-])|\.local\.(?:json|ps1|bat)$|\.old-account\./i
const keyPatterns = [/\bsk-[A-Za-z0-9_-]{16,}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g]
for (const file of new Set(paths)) {
  if (denied.test(file)) { issues.push({ file, reason: 'Private/runtime/backup file is not allowed in Git' }); continue }
  const binary = staged || head ? execFileSync('git', ['show', `${head ? 'HEAD' : ''}:${file}`], { maxBuffer: 32 * 1024 * 1024 }) : readFileSync(path.join(root, file))
  if (privateHashes.has(createHash('sha256').update(binary).digest('hex'))) {
    issues.push({ file, reason: 'Matches a registered private profile or reference asset' }); continue
  }
  if (/\.ico$/i.test(file)) continue
  let text
  try { text = staged || head ? git(['show', `${head ? 'HEAD' : ''}:${file}`]) : readFileSync(path.join(root, file), 'utf8') }
  catch { issues.push({ file, reason: 'Unable to inspect tracked content' }); continue }
  if (privateTexts.some(s => text.includes(s))) issues.push({ file, reason: 'Contains registered private profile content' })
  for (const secret of secrets) if (text.includes(secret)) { issues.push({ file, reason: 'Contains a credential from local private configuration' }); break }
  for (const re of keyPatterns) {
    re.lastIndex = 0
    const m = re.exec(text)
    // Explicit repeated dummy values used by offline tests are not real credentials.
    if (m && !/^(?:sk-)?([xX0])\1+$/.test(m[0])) issues.push({ file, line: text.slice(0, m.index).split('\n').length, reason: 'Possible embedded API token or private key' })
  }
}
if (issues.length) {
  console.error(JSON.stringify({ ok: false, issues }, null, 2)); process.exitCode = 1
} else console.log(`Repository check passed: ${new Set(paths).size} files; credentials and runtime files excluded (${staged ? 'index' : head ? 'commit' : 'working tree'}).`)
