<#
  定期检查指定机器人与 NapCat 进程；进程不存在时启动对应计划任务。
  多实例时仅报告异常，不结束进程。实例参数读取 windows.local.json。
  -DryRun 仅报告启动动作，不启动任务。
#>
param(
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'

$root      = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'windows-settings.ps1')
$windowsSettings = Get-KoukouWindowsSettings
$logDir    = Join-Path $root 'logs'
$logFile   = Join-Path $logDir 'supervisor.log'
$logMaxBytes = 1MB
$heartbeatEvery = 10   # 每 10 轮（约 30 分钟）记一次心跳，其余无事则静默

function Write-SLog {
  param([string]$Level, [string]$Message)
  try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy/MM/dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    if (-not $Quiet) { Write-Host $line }
    $item = Get-Item $logFile -ErrorAction SilentlyContinue
    if ($item -and $item.Length -gt $logMaxBytes) { Move-Item -Path $logFile -Destination ($logFile + '.1') -Force }
  } catch { }
}

$stateFile = Join-Path $root 'data\supervisor-state.json'
$state = @{ ticks = 0 }
try {
  if (Test-Path $stateFile) {
    $obj = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $state[$p.Name] = $p.Value }
  }
} catch { }
$state.ticks = [int]$state.ticks + 1

$actions = @()

# ── 1. 机器人进程 ──────────────────────────────────────────────
# 只认本项目自己的实例（排除 harness 自己的 runner —— 它的命令行里会带脚本原文）
$botProcs = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and
  $_.CommandLine -match 'index\.js' -and
  $_.CommandLine -match ('--profile=' + [regex]::Escape($windowsSettings.BotProfile) + '(?:\s|$)') -and
  $_.CommandLine -notmatch 'dsh|runner|subprocess-local'
})
if ($botProcs.Count -eq 0) {
  $actions += ('机器人进程不存在 → 启动 ' + $windowsSettings.BotTaskName)
  if (-not $DryRun) { Start-ScheduledTask -TaskName $windowsSettings.BotTaskName }
} elseif ($botProcs.Count -gt 1) {
  # 多实例**不杀**，只报警：单实例锁已经能防住，出现多个说明别的地方有问题，需要人看
  $actions += ('⚠ 发现 {0} 个机器人实例（本脚本不杀进程，请人工确认）' -f $botProcs.Count)
}

# ── 2. NapCat 进程 ────────────────────────────────────────────
$napcat = @()
if ($windowsSettings.NapCatDir) {
  $napcat = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($windowsSettings.NapCatDir.TrimEnd('\') + '\*') })
  if ($napcat.Count -eq 0) {
    $actions += ('NapCat 进程不存在 → 启动 ' + $windowsSettings.NapCatTaskName)
    if (-not $DryRun) { Start-ScheduledTask -TaskName $windowsSettings.NapCatTaskName }
  }
}

if ($actions.Count -gt 0) {
  Write-SLog 'ACTION' ($actions -join '；')
} elseif (($state.ticks % $heartbeatEvery) -eq 0) {
  Write-SLog 'INFO' ('心跳：机器人 {0} 个｜NapCat {1} 个｜一切正常' -f $botProcs.Count, $napcat.Count)
}

if (-not $Quiet) {
  Write-Host ''
  Write-Host '──── 哨兵检查结果 ────'
  Write-Host ('  机器人进程 : {0} 个' -f $botProcs.Count)
  Write-Host ('  NapCat 进程: {0} 个' -f $napcat.Count)
  Write-Host ('  本次动作   : {0}' -f $(if ($actions.Count -gt 0) { $actions -join '；' } else { '无（一切正常）' }))
  if ($DryRun) { Write-Host '  模式       : DryRun（只报告，未启动任何东西）' }
  Write-Host '──────────────────────'
}

try {
  $dir = Split-Path -Parent $stateFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  ($state | ConvertTo-Json -Depth 5) | Set-Content -Path $stateFile -Encoding UTF8
} catch { }

exit 0
