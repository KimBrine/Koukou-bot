<#
  打开 Koukou 控制台：机器人没在跑就先把机器人拉起来，然后用 Edge/Chrome 的 app 模式
  打开一个没有地址栏的独立窗口（看起来就是个桌面应用）。

  由「Koukou 控制台.vbs」以隐藏窗口调用，也可以直接右键用 PowerShell 运行。

  并行两个机器人实例时，用参数指定开哪一个（默认 = 实例 1）：
    -EnvFile  该实例的 .env（端口和实例身份都从它读）
    -TaskName 控制台没起来时要拉起的计划任务
    实例 2 的调用方式见「启动控制台2.vbs」。
#>
param(
  [string]$EnvFile = '',
  [int]$Port = 0,
  [string]$TaskName = '',
  [string]$Title = 'Koukou 控制台'
)
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
. (Join-Path $root 'windows-settings.ps1')
$windowsSettings = Get-KoukouWindowsSettings
if (-not $EnvFile) { $EnvFile = $windowsSettings.BotEnvFile }
if (-not $TaskName) { $TaskName = $windowsSettings.BotTaskName }

# 没显式给端口就从该实例的 .env 里读 ADMIN_PORT
if (-not $Port) {
  $Port = 8787
  $envPath = if ($EnvFile) { $EnvFile } else { Join-Path $root '.env' }
  if (Test-Path $envPath) {
    $m = Select-String -Path $envPath -Pattern '^\s*ADMIN_PORT\s*=\s*(\d+)' -Encoding UTF8 | Select-Object -First 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
  }
}
$url = "http://127.0.0.1:$Port"

function Test-Console {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $a = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $a.AsyncWaitHandle.WaitOne(700)) { return $false }
    $c.EndConnect($a)
    return $true
  } catch { return $false } finally { try { $c.Close() } catch {} }
}

if (-not (Test-Console)) {
  # 控制台没起来：多半是机器人没在跑，拉起来等它就位
  Start-ScheduledTask -TaskName $TaskName
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 800
    if (Test-Console) { break }
  }
}

if (-not (Test-Console)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "控制台没有起来（端口 $Port），机器人可能启动失败了。`n请看该实例的 logs\console.log 与 logs\bot.log 的最后几行。",
    $Title
  ) | Out-Null
  exit 1
}

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
  # app 模式：独立窗口、无地址栏、有独立任务栏图标。
  # 不要加 --user-data-dir：浏览器已经在跑时它会被忽略，只会让进程识别变复杂。
  Start-Process -FilePath $edge -ArgumentList @("--app=$url", '--window-size=1280,860')
} else {
  Start-Process $url
}
