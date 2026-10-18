param([Parameter(Mandatory=$true)][string]$FilePath)
$resolved = (Resolve-Path -LiteralPath $FilePath -ErrorAction Stop).Path
$work = Join-Path (Split-Path -Parent $resolved) 'bin\llbot'
if (-not (Test-Path -LiteralPath $work -PathType Container)) { throw 'LLBot 工作目录不存在' }
Start-Process -FilePath $resolved -ArgumentList '--headless' -WorkingDirectory $work -WindowStyle Hidden
