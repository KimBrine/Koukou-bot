<#
  最小哨兵：**只负责把死掉的进程拉起来，永不杀任何东西。**

  和已经被删掉的那个看门狗的区别（那一个是反面教材）：
    看门狗：掉线就杀进程重启、每 6 分钟循环、失败还反复重试 → 会误杀、会空转、会刷二维码
    本脚本：**代码里没有任何 Stop-Process / 重启逻辑**，只有"不在跑 → 启动"
            → 从原理上就不可能杀错东西，也不可能把健康的东西弄坏

  为什么需要它：一天之内出现过两次长时间静默
    ① 2026-09-27 13:26 残留锁把启动挡了 → 白停 10 小时
    ② 2026-09-27 23:56 进程静默死亡，无日志无崩溃记录 → 没人发现
  这两次只要有个"每 3 分钟看一眼"的东西就能在几分钟内恢复。

  由计划任务 KoukouSupervisor 每 3 分钟以隐藏窗口运行一次。
  手动排查：
    powershell -NoProfile -ExecutionPolicy Bypass -File bot-supervisor.ps1            # 立即检查一次
    powershell -NoProfile -ExecutionPolicy Bypass -File bot-supervisor.ps1 -DryRun    # 只报告，不启动
#>
param(
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'

$root      = Split-Path -Parent $MyInvocation.MyCommand.Path
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
  $_.CommandLine -match '--profile=new' -and
  $_.CommandLine -notmatch 'dsh|runner|subprocess-local'
})
if ($botProcs.Count -eq 0) {
  $actions += '机器人进程不存在 → 启动 DeepSeekQQBotNew'
  if (-not $DryRun) { Start-ScheduledTask -TaskName 'DeepSeekQQBotNew' }
} elseif ($botProcs.Count -gt 1) {
  # 多实例**不杀**，只报警：单实例锁已经能防住，出现多个说明别的地方有问题，需要人看
  $actions += ('⚠ 发现 {0} 个机器人实例（本脚本不杀进程，请人工确认）' -f $botProcs.Count)
}

# ── 2. NapCat 进程 ────────────────────────────────────────────
$napcat = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like 'E:\NapCatQQ2\*' })
if ($napcat.Count -eq 0) {
  $actions += 'NapCat 进程不存在 → 启动 NapCatQQ2'
  if (-not $DryRun) { Start-ScheduledTask -TaskName 'NapCatQQ2' }
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
