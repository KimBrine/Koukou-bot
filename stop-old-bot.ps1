param([switch]$DryRun)
# 仅检查本实例锁文件、完整入口路径、profile 和启动时间；不按端口猜测进程。
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = if ($env:BOT_DATA_DIR) { $env:BOT_DATA_DIR } else { Join-Path $root 'data' }
$instanceProfile = if ($env:BOT_PROFILE) { $env:BOT_PROFILE } else { 'main' }
$lock = Join-Path $dataDir 'bot.lock'
if (-not (Test-Path -LiteralPath $lock)) { return }
try {
  $info = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
  $candidatePid = [int]$info.pid
  if ($candidatePid -le 0 -or $candidatePid -eq $PID -or $info.profile -cne $instanceProfile) { return }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$candidatePid" -ErrorAction Stop
  if (-not $proc -or $proc.Name -ne 'node.exe') { return }
  $entry = (Get-Item -LiteralPath (Join-Path $root 'src\index.js') -ErrorAction Stop).FullName
  $command = [string]$proc.CommandLine
  $arguments = @([regex]::Matches($command, '"([^"]*)"|(\S+)') | ForEach-Object {
    if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
  })
  if ($arguments.Count -lt 3 -or -not [IO.Path]::IsPathRooted($arguments[1])) { return }
  # Get-Item 展开 Windows 8.3 短路径；比较整个脚本参数，避免前缀或备份文件误匹配。
  $candidateEntry = (Get-Item -LiteralPath $arguments[1] -ErrorAction Stop).FullName
  if (-not [string]::Equals($candidateEntry, $entry, [StringComparison]::OrdinalIgnoreCase)) { return }
  if ($arguments -cnotcontains ('--profile=' + $instanceProfile)) { return }
  if (-not $info.startedAt -or [Math]::Abs((([DateTime]$proc.CreationDate).ToUniversalTime() - ([DateTime]$info.startedAt).ToUniversalTime()).TotalSeconds) -gt 15) { return }
  if ($DryRun) { Write-Output "verified-instance pid=$candidatePid"; return }
  Stop-Process -Id $candidatePid -ErrorAction Stop
  Write-Output "stopped matching instance pid=$candidatePid"
} catch {
  Write-Warning '无法确认旧实例归属，未结束任何进程。'
}
