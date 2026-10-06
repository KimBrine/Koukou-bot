param(
  [Parameter(Mandatory = $true)][int]$BotPid,
  [Parameter(Mandatory = $true)][string]$BotProfile,
  [Parameter(Mandatory = $true)][string]$TaskName,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $root 'logs\restart.log'
function Write-Result([string]$message) {
  Add-Content -LiteralPath $log -Encoding UTF8 -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
}
try {
  if (-not $DryRun) { Write-Result "Starting profile=$BotProfile pid=$BotPid task=$TaskName" }
  if ($BotProfile -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid profile' }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$BotPid"
  if (-not $proc -or $proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch 'src[\\/]index\.js' -or $proc.CommandLine -notlike "*--profile=$BotProfile*") {
    throw "PID $BotPid is not the expected bot profile"
  }
  if ($DryRun) { Write-Output "Would restart PID $BotPid via $TaskName"; exit 0 }
  Start-Sleep -Milliseconds 1200
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$BotPid"
  if (-not $proc -or $proc.Name -ne 'node.exe' -or $proc.CommandLine -notlike "*--profile=$BotProfile*") {
    throw "Bot process changed before restart"
  }
  Stop-Process -Id $BotPid -Force
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $TaskName
  Write-Result "Restarted profile=$BotProfile oldPid=$BotPid task=$TaskName"
} catch {
  Write-Result "FAILED profile=$BotProfile pid=$BotPid task=${TaskName}: $($_.Exception.Message)"
  exit 1
}
