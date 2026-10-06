Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-settings.ps1')
$launcherSettings = Get-KoukouLauncherSettings
$root = $launcherSettings.NapCatDir
$webConfig = Join-Path $root 'napcat\config\webui.json'
$bootExe = Join-Path $root 'napcat\NapCatWinBootMain.exe'
$botEnvFile = $launcherSettings.BotEnvFile
$taskName = $launcherSettings.TaskName
. (Join-Path $PSScriptRoot 'napcat-status.ps1')

function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(350)) { return $false }
    $client.EndConnect($connect)
    return $true
  } catch { return $false }
  finally { $client.Close() }
}
function Get-BootProcess {
  Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'" |
    Where-Object { $_.ExecutablePath -eq $bootExe } |
    Select-Object -First 1
}
function Get-WebUrl {
  try {
    $config = Get-Content -LiteralPath $webConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $port = Get-WebPort
    $token = [string]$config.token
    $base = "http://127.0.0.1:$port/webui"
    if ($token) { return $base + '?token=' + [uri]::EscapeDataString($token) }
    return $base
  } catch { return 'http://127.0.0.1:6199/webui' }
}
function Get-WebPort {
  try {
    $config = Get-Content -LiteralPath $webConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.port) { return [int]$config.port }
  } catch {}
  return 6199
}
function Get-ConsoleUrl {
  $port = 8788
  try {
    $match = Select-String -LiteralPath $botEnvFile -Pattern '^\s*ADMIN_PORT\s*=\s*(\d+)' -Encoding UTF8 | Select-Object -First 1
    if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
  } catch {}
  return "http://127.0.0.1:$port/"
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'NapCat · 快速启动'
$form.Size = New-Object System.Drawing.Size(550,370)
$form.MinimumSize = New-Object System.Drawing.Size(500,350)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(15,25,42)
$form.ForeColor = [System.Drawing.Color]::FromArgb(238,245,255)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI',10)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Join-Path $root 'win64\QQ.exe')) } catch {}

function Add-Label([string]$value,[int]$x,[int]$y,[int]$w,[int]$h,[int]$size,[bool]$bold) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $value
  $label.Location = New-Object System.Drawing.Point($x,$y)
  $label.Size = New-Object System.Drawing.Size($w,$h)
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI',$size,$style)
  $form.Controls.Add($label)
  return $label
}
function Add-Button([string]$value,[int]$x,[int]$y,[int]$w,[System.Drawing.Color]$color) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $value
  $button.Location = New-Object System.Drawing.Point($x,$y)
  $button.Size = New-Object System.Drawing.Size($w,43)
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = $color
  $button.ForeColor = [System.Drawing.Color]::White
  $button.Cursor = 'Hand'
  $form.Controls.Add($button)
  return $button
}

$title = Add-Label 'NapCat 启动中心' 26 22 450 43 21 $true
$intro = Add-Label '启动、登录与连接状态都在这里查看。' 28 68 470 27 10 $false
$intro.ForeColor = [System.Drawing.Color]::FromArgb(158,177,200)
$status = Add-Label '正在检查…' 28 111 470 36 15 $true
$details = Add-Label '' 28 151 480 52 9 $false
$details.ForeColor = [System.Drawing.Color]::FromArgb(158,177,200)
$openWeb = Add-Button '打开 NapCat 登录页' 28 222 215 ([System.Drawing.Color]::FromArgb(55,139,137))
$openConsole = Add-Button '打开机器人控制台' 252 222 240 ([System.Drawing.Color]::FromArgb(68,99,165))
$refresh = Add-Button '刷新状态' 28 274 140 ([System.Drawing.Color]::FromArgb(44,66,92))
$start = Add-Button '启动 NapCat' 178 274 140 ([System.Drawing.Color]::FromArgb(44,66,92))
$close = Add-Button '关闭窗口' 328 274 164 ([System.Drawing.Color]::FromArgb(44,66,92))

function Update-Status {
  try {
    $process = Get-BootProcess
    $webPort = Get-WebPort
    $web = Test-Port $webPort
    $connection = Get-NapCatConnection $botEnvFile
    $onebotPort = ([uri]$connection.Url).Port
    $onebot = Test-Port $onebotPort
    if ($process -and $onebot) {
      $health = Get-NapCatQQStatus $connection.Url $connection.AccessToken
      $display = Get-NapCatAccountDisplay $health
      $status.Text = $display.Text
      $status.ForeColor = switch ($display.Color) {
        'online' { [System.Drawing.Color]::FromArgb(102,224,169) }
        'offline' { [System.Drawing.Color]::FromArgb(255,135,145) }
        default { [System.Drawing.Color]::FromArgb(245,190,111) }
      }
      $details.Text = $display.Details
      $start.Enabled = $false
    } elseif ($process -and $web) {
      $status.Text = '●  等待 QQ 登录'
      $status.ForeColor = [System.Drawing.Color]::FromArgb(245,190,111)
      $details.Text = 'NapCat 已启动。打开登录页扫码；登录后这里会自动变成已连接。'
      $start.Enabled = $false
    } elseif ($process) {
      $status.Text = '●  正在启动'
      $status.ForeColor = [System.Drawing.Color]::FromArgb(245,190,111)
      $details.Text = '正在等待 NapCat 的登录页和 OneBot 服务就绪。'
      $start.Enabled = $false
    } else {
      $status.Text = '●  尚未启动'
      $status.ForeColor = [System.Drawing.Color]::FromArgb(255,135,145)
      $details.Text = '点击“启动 NapCat”。登录页就绪后可扫码登录。'
      $start.Enabled = $true
    }
    $openWeb.Enabled = $web
  } catch {
    $status.Text = '●  状态读取失败'
    $details.Text = $_.Exception.Message
  }
}
function Start-NapCat {
  if (Get-BootProcess) { Update-Status; return }
  try {
    Start-ScheduledTask -TaskName $taskName
    $status.Text = '●  已请求启动'
    $details.Text = '正在等待登录页就绪…'
    $start.Enabled = $false
  } catch {
    $status.Text = '●  启动失败'
    $details.Text = $_.Exception.Message
  }
}

$openWeb.Add_Click({ Start-Process -FilePath (Get-WebUrl) })
$openConsole.Add_Click({ Start-Process -FilePath (Get-ConsoleUrl) })
$refresh.Add_Click({ Update-Status })
$start.Add_Click({ Start-NapCat })
$close.Add_Click({ $form.Close() })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2500
$timer.Add_Tick({ Update-Status })
$form.Add_Shown({ Update-Status; if (-not (Get-BootProcess)) { Start-NapCat }; $timer.Start() })
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
[void]$form.ShowDialog()
