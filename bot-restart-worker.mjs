import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const [pidArg, taskName, logDir, dryRunArg] = process.argv.slice(2)
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
  await sleep(800)
  const taskTool = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe')
  const result = spawnSync(taskTool, ['/Run', '/TN', taskName], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    throw new Error(`Task start failed: ${result.error?.message || result.stderr?.trim() || result.status}`)
  }
  log(`Restarted botPid=${botPid} task=${taskName}`)
}

main().catch((error) => {
  try { log(`FAILED botPid=${botPid} task=${taskName}: ${error.message}`) } catch {}
  process.exitCode = 1
})
