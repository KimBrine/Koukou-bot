param([Parameter(Mandatory=$true)][string]$ProtocolDir,[Parameter(Mandatory=$true)][string]$TaskName)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$resolved=(Resolve-Path -LiteralPath $ProtocolDir).Path.TrimEnd('\')
if ($resolved.Length -le 3 -or -not (Test-Path -LiteralPath $resolved -PathType Container)) { throw '协议端目录不是明确的实例文件夹' }
$prefix=$resolved+'\'
$task=Get-ScheduledTask -TaskName $TaskName
if (@($task).Count -ne 1) { throw '未找到唯一的协议端计划任务' }
$ownsTask=$false
foreach ($action in $task.Actions) {
    $launch=([string]$action.Execute)+' '+([string]$action.Arguments)+' '+([string]$action.WorkingDirectory)+'\'
    if ($launch.IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $ownsTask=$true }
}
if (-not $ownsTask) { throw '计划任务入口与指定协议端目录不匹配，未重启任何进程' }
$processes=@(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
})
foreach ($instance in $processes) {
    if ($instance.ProcessId -ne $PID) { Stop-Process -Id $instance.ProcessId -Force -ErrorAction SilentlyContinue }
}
if ($processes.Count -gt 0) { Start-Sleep -Seconds 2 }
Start-ScheduledTask -TaskName $TaskName
Write-Output '当前协议端实例重启请求已提交'
