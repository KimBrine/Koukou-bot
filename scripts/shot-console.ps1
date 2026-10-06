param(
  [string]$Out = "$env:TEMP\koukou-console.png",
  [string]$Url = 'http://127.0.0.1:8787',
  [int]$W = 1280,
  [int]$H = 940,
  [string]$Click = '',
  [switch]$NoLaunch,
  [switch]$KeepOpen
)

# Screenshot the Koukou console app window (Edge --app mode) so we can visually verify the UI.
# Only the app window is captured (PrintWindow), never the whole desktop.

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$profileDir = Join-Path $env:TEMP 'koukou-console-profile'
$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# 先清掉上一次留下的窗口，否则多实例会让坐标/抓取对象飘掉
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like "*$profileDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

if (-not $NoLaunch) {
  Start-Process -FilePath $edge -ArgumentList @(
    "--app=$Url", "--window-size=$W,$H", "--window-position=0,0", "--user-data-dir=$profileDir",
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9223'
  ) | Out-Null
  Start-Sleep -Seconds 7
}

$win = Get-Process msedge -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Koukou' } |
  Select-Object -First 1
if (-not $win) {
  $win = Get-Process msedge, chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
if (-not $win) { Write-Host 'NO_WINDOW'; exit 1 }

[WinCap]::ShowWindow($win.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
[WinCap]::SetForegroundWindow($win.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900

# Optional: click a nav item by simulating a real mouse click at a computed point.
if ($Click -ne '') {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@
  $rect = New-Object WinCap+RECT
  [WinCap]::GetWindowRect($win.MainWindowHandle, [ref]$rect) | Out-Null
  $parts = $Click -split ','
  $cx = $rect.Left + [int]$parts[0]
  $cy = $rect.Top + [int]$parts[1]
  [M]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 250
  [M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 1200
}

$r = New-Object WinCap+RECT
[WinCap]::GetWindowRect($win.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Host 'BAD_RECT'; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT (needed for Chromium windows)
[WinCap]::PrintWindow($win.MainWindowHandle, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

if (-not $KeepOpen) {
  Get-Process msedge -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -match 'Koukou' } |
    ForEach-Object { $_.CloseMainWindow() | Out-Null }
}
Write-Host ("SHOT_OK " + $Out + " " + $w + "x" + $h)
