// Deliberate allowlist: legacy probe/test scripts may send real QQ messages or call paid APIs.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scripts = [
  'test-summary-report.mjs', 'test-summary-format.mjs', 'test-summary-quality.mjs', 'test-summary-progress.mjs',
  'test-summary-content.mjs', 'test-summary-names.mjs', 'test-summary-schedule.mjs', 'test-summary-jobs.mjs', 'test-summary-failure.mjs',
  'test-online-status.mjs', 'test-auto-plus-one.mjs', 'test-image-cache.mjs', 'test-admin-groups.mjs', 'test-message-freshness.mjs', 'test-model-request.mjs',
  'test-forward-records.mjs', 'test-message-context.mjs', 'test-proactive-delivery.mjs',
  'test-persona-files.mjs',
  'test-summary-references.mjs',
  'test-summary-reference-selection.mjs',
  'test-summary-capture.mjs',
  'test-vision-knowledge.mjs',
  'test-reply-metadata.mjs',
  'test-persona-memory.mjs',
  'test-private-profiles.mjs',
  'test-admin-commands.mjs',
  'test-memory-session.mjs',
  'test-fork-integration.mjs',
  'test-custom-schedule.mjs',
  'test-launcher-safety.mjs',
  'test-command-center.mjs',
  'test-group-mute.mjs',
  'test-self-actions.mjs',
  'test-summary-depth.mjs',
  'test-summary-unrestricted.mjs',
  'test-model-catalog.mjs', 'test-web-search.mjs', 'test-music.mjs', 'test-console-structure.mjs', 'test-memory-keys.mjs', 'test-private-whitelist.mjs',
  'test-persona-stickers.mjs', 'test-stickers.mjs', 'test-upload-updates.mjs',
  'test-sticker-send.mjs',
  'test-sticker-learn.mjs',
  'test-summary-request-recovery.mjs',
  'test-quiet-greetings.mjs',
  'test-memory-edit.mjs', 'test-memory-retry.mjs',
  'test-dev-integration.mjs', 'test-dev-merge-safety.mjs',
  'test-reply-budget.mjs',
  'test-vision-providers.mjs',
  'test-python-plugins.mjs',
]
for (const file of scripts) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', file)], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`Offline regression suite passed: ${scripts.length} scripts. No QQ messages or paid model calls.`)
