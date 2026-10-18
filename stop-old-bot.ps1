param([switch]$DryRun)
# 仅检查本实例锁文件、完整入口路径、profile 和启动时间；不按端口猜测进程。
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = if ($env:BOT_DATA_DIR) { $env:BOT_DATA_DIR } else { Join-Path $root 'data' }
$profile = if ($env:BOT_PROFILE) { $env:BOT_PROFILE } else { 'main' }
$lock = Join-Path $dataDir 'bot.lock'
if (-not (Test-Path -LiteralPath $lock)) { return }
try {
  $info = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
  $candidatePid = [int]$info.pid
  if ($candidatePid -le 0 -or $candidatePid -eq $PID -or $info.profile -ne $profile) { return }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$candidatePid" -ErrorAction Stop
  if (-not $proc -or $proc.Name -ne 'node.exe') { return }
  $entry = [IO.Path]::GetFullPath((Join-Path $root 'src\index.js'))
  $command = [string]$proc.CommandLine
  if ($command.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
  if ($command -notmatch ('--profile=' + [regex]::Escape($profile) + '(?:\s|$)')) { return }
  if (-not $info.startedAt -or [Math]::Abs((([DateTime]$proc.CreationDate).ToUniversalTime() - ([DateTime]$info.startedAt).ToUniversalTime()).TotalSeconds) -gt 15) { return }
  if ($DryRun) { Write-Output "verified-instance pid=$candidatePid"; return }
  Stop-Process -Id $candidatePid -ErrorAction Stop
  Write-Output "stopped matching instance pid=$candidatePid"
} catch {
  Write-Warning '无法确认旧实例归属，未结束任何进程。'
}
