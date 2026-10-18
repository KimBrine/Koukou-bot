# 结束上一次的机器人实例（相对本脚本所在目录，不写死盘符）
# 三种识别：锁文件里的 pid / 占着 8787 控制台的进程 / 命令行含本目录名
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pids = @()
$lock = Join-Path $root 'data\bot.lock'
if (Test-Path $lock) {
  try { $pids += [int]((Get-Content $lock -Raw | ConvertFrom-Json).pid) } catch { }
}
try { $pids += [int](Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction Stop).OwningProcess } catch { }
$pids = $pids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique
foreach ($p in $pids) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Output ("killed old bot pid " + $p) } catch { }
  }
}
