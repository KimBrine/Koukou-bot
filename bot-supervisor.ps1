<#
  看门狗：检查机器人控制台（/api/ping）与 OneBot 端口。
  - 控制台端口没监听 → 启动机器人计划任务
  - 端口在但连续 2 次无响应（假死）→ 结束并重启整棵任务
  - 3001 没监听 → 一并拉起（start-bot.bat 会先起 LLBot）
  -DryRun 只报告不动手
#>
param(
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'windows-settings.ps1')
$windowsSettings = Get-KoukouWindowsSettings
$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'supervisor.log'
$heartbeatEvery = 10

function Write-SLog {
  param([string]$Level, [string]$Message)
  try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy/MM/dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    if (-not $Quiet) { Write-Host $line }
  } catch { }
}

$stateFile = Join-Path $root 'data\supervisor-state.json'
$state = @{ ticks = 0; healthFails = 0 }
try {
  if (Test-Path $stateFile) {
    $obj = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $state[$p.Name] = $p.Value }
  }
} catch { }
$state.ticks = [int]$state.ticks + 1
$state.healthFails = [int]$state.healthFails

$consolePort = 8787
$onebotPort = 3001
try {
  $envFile = Join-Path $root '.env'
  if (Test-Path $envFile) {
    $envLines = Get-Content $envFile -Encoding UTF8
    $p1 = $envLines | Where-Object { $_ -match '^ADMIN_PORT=' } | Select-Object -First 1
    if ($p1) { $consolePort = [int](($p1 -split '=', 2)[1].Trim()) }
    $p2 = $envLines | Where-Object { $_ -match '^ONEBOT_WS_URL=' } | Select-Object -First 1
    if ($p2 -and ($p2 -match ':(\d{2,5})')) { $onebotPort = [int]$matches[1] }
  }
} catch { }

$actions = @()

function Test-Port([int]$port) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  return [bool]$c
}
function Test-Ping([int]$port) {
  try {
    $r = Invoke-WebRequest ("http://127.0.0.1:{0}/api/ping" -f $port) -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}
function Restart-BotTask {
  if ($DryRun) { $actions += ('（DryRun）将重启 ' + $windowsSettings.BotTaskName); return }
  try {
    Stop-ScheduledTask -TaskName $windowsSettings.BotTaskName
    Start-Sleep -Seconds 5
    Start-ScheduledTask -TaskName $windowsSettings.BotTaskName
  } catch { $actions += ('重启失败：' + $_.Exception.Message) }
}

$consoleUp = Test-Port $consolePort
if (-not $consoleUp) {
  $actions += ('控制台端口 {0} 未监听 → 启动 {1}' -f $consolePort, $windowsSettings.BotTaskName)
  if (-not $DryRun) { Start-ScheduledTask -TaskName $windowsSettings.BotTaskName }
  $state.healthFails = 0
} else {
  if (Test-Ping $consolePort) {
    $state.healthFails = 0
  } else {
    # 复检一次：10 秒仍无响应就判定卡死，立刻重启（不必等下一轮）
    Start-Sleep -Seconds 10
    if (Test-Ping $consolePort) {
      $state.healthFails = 0
    } else {
      $state.healthFails = $state.healthFails + 1
      $actions += '机器人卡死（端口在但不响应）→ 结束并重启任务'
      Restart-BotTask
      $state.healthFails = 0
    }
  }
}

if (-not (Test-Port $onebotPort)) {
  $actions += ('OneBot 端口 {0} 未监听 → 启动 {1}' -f $onebotPort, $windowsSettings.BotTaskName)
  if (-not $DryRun) { Start-ScheduledTask -TaskName $windowsSettings.BotTaskName }
}

if ($actions.Count -gt 0) {
  Write-SLog 'ACTION' ($actions -join '；')
} elseif (($state.ticks % $heartbeatEvery) -eq 0) {
  Write-SLog 'INFO' ('心跳：控制台 {0}｜OneBot {1}｜一切正常' -f $consolePort, $onebotPort)
}

if (-not $Quiet) {
  Write-Host ''
  Write-Host '──── 哨兵检查结果 ────'
  Write-Host ('  控制台 : {0}:{1}' -f $(if ($consoleUp) { '在' } else { '不在' }), $consolePort)
  Write-Host ('  本次动作: {0}' -f $(if ($actions.Count -gt 0) { $actions -join '；' } else { '无（一切正常）' }))
  Write-Host '──────────────────────'
}

try {
  $dir = Split-Path -Parent $stateFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  ($state | ConvertTo-Json -Depth 5) | Set-Content -Path $stateFile -Encoding UTF8
} catch { }

exit 0
