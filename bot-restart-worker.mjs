import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const [pidArg, taskName, logDir, dryRunArg] = process.argv.slice(2)
const profile = (process.argv.slice(2).find((a) => String(a).startsWith('--profile=')) || '--profile=main').slice(10)
const botPid = Number(pidArg)
const logFile = path.join(logDir || '.', 'restart-worker.log')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (message) => appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`)
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function main() {
  if (!Number.isInteger(botPid) || botPid <= 0 || botPid === process.pid) throw new Error('Invalid bot PID')
  if (!/^[A-Za-z0-9_-]+$/.test(taskName || '')) throw new Error('Invalid task name')
  log(`Starting botPid=${botPid} task=${taskName} workerPid=${process.pid}`)
  if (dryRunArg === '--dry-run') {
    log('Dry run complete')
    return
  }
  await sleep(1200)
  if (!alive(botPid)) throw new Error('Bot exited before restart')
  process.kill(botPid, 'SIGTERM')
  for (let i = 0; i < 20 && alive(botPid); i++) await sleep(250)
  if (alive(botPid)) throw new Error('Bot did not stop')
  const cleared = killTree(profile)
  log(`Tree cleared: ${cleared} process(es)`)
  await sleep(800)
  const taskTool = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe')
  const result = spawnSync(taskTool, ['/Run', '/TN', taskName], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    throw new Error(`Task start failed: ${result.error?.message || result.stderr?.trim() || result.status}`)
  }
  log(`Restarted botPid=${botPid} task=${taskName}`)
}

/** 结束整棵机器人进程树：同 profile 的 node（src\\index.js）与承载它的 cmd（start-bot.bat）。不动 LLBot。 */
function killTree(profile) {
  const name = String(profile || 'main').replace(/'/g, "''")
  const script = [
    "$profileName = '" + name + "'",
    '$killed = @()',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $c = [string]$_.CommandLine',
    "  if ($_.Name -eq 'node.exe' -and $c -match 'src\\index\.js') {",
    '    $m = [regex]::Match($c, \'--profile=([^\s"]+)\')',
    "    $prof = if ($m.Success) { $m.Groups[1].Value } else { 'main' }",
    '    if ($prof -eq $profileName) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed += $_.ProcessId }',
    "  } elseif ($_.Name -eq 'cmd.exe' -and $c -match 'start-bot\.bat') {",
    '    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed += $_.ProcessId',
    '  }',
    '}',
    'Write-Output $killed.Count'
  ].join('\n')
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    return String(r.stdout || '').trim() || '0'
  } catch (error) {
    log('killTree failed: ' + error.message)
    return '0'
  }
}

main().catch((error) => {
  try { log(`FAILED botPid=${botPid} task=${taskName}: ${error.message}`) } catch {}
  process.exitCode = 1
})
