// Deliberate allowlist: legacy probe/test scripts may send real QQ messages or call paid APIs.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scripts = [
  'test-summary-report.mjs', 'test-summary-format.mjs', 'test-summary-quality.mjs',
  'test-summary-content.mjs', 'test-summary-names.mjs', 'test-summary-schedule.mjs', 'test-summary-failure.mjs',
  'test-online-status.mjs', 'test-auto-plus-one.mjs', 'test-image-cache.mjs', 'test-admin-groups.mjs',
]
for (const file of scripts) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', file)], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`Offline regression suite passed: ${scripts.length} scripts. No QQ messages or paid model calls.`)
