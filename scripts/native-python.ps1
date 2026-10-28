param(
  [ValidateSet('start','stop')][string]$Action = 'start',
  [Parameter(Mandatory=$true)][string]$Python,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$EnvFile,
  [Parameter(Mandatory=$true)][string]$DataDir,
  [Parameter(Mandatory=$true)][string]$LogDir,
  [Parameter(Mandatory=$true)][string]$Profile,
  [int]$Port = 0,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
foreach ($entry in @($Python,$Root,$EnvFile,$DataDir,$LogDir)) {
  if (-not [IO.Path]::IsPathRooted($entry)) { throw 'All instance paths must be absolute.' }
}
$pythonPath = (Get-Item -LiteralPath $Python).FullName
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw 'An existing instance environment file is required.' }
$nativeArguments = @('-X','utf8','-m','koukou','--root',$Root,'--env-file',$EnvFile)
if ($Action -eq 'start') {
  $nativeArguments += 'run'
  $nativeArguments += $(if ($Execute) { '--enable-native' } else { '--check' })
} else {
  $nativeArguments += 'stop-native'
  if ($Execute) { $nativeArguments += '--execute' }
}
$nativeArguments += @('--data-dir',$DataDir,'--log-dir',$LogDir,'--profile',$Profile)
if ($Port -ne 0) { $nativeArguments += @('--port',[string]$Port) }
# Foreground only: no scheduled task, watchdog, hidden launcher or shell-built command.
& $pythonPath @nativeArguments
exit $LASTEXITCODE
