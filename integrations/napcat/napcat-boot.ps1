$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-settings.ps1')
$settings = Get-KoukouLauncherSettings
$installRoot = $settings.NapCatDir
$napcatCode = Join-Path $installRoot 'napcat'
$qqExe = Join-Path $installRoot 'win64\QQ.exe'
$bootExe = Join-Path $napcatCode 'NapCatWinBootMain.exe'
$hookDll = Join-Path $napcatCode 'NapCatWinBootHook.dll'
$mainScript = Join-Path $napcatCode 'napcat.mjs'
foreach ($required in @($qqExe, $bootExe, $hookDll, $mainScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing NapCat runtime file: $required" }
}
$env:NAPCAT_PATCH_PACKAGE = Join-Path $napcatCode 'qqnt.json'
$env:NAPCAT_LOAD_PATH = Join-Path $napcatCode 'loadNapCat.js'
$env:NAPCAT_INJECT_PATH = $hookDll
$env:NAPCAT_LAUNCHER_PATH = $bootExe
$env:NAPCAT_MAIN_PATH = $mainScript
if ($settings.Account) { $env:NAPCAT_QUICK_ACCOUNT = $settings.Account }
# Optional credentials remain in an ignored local file; QR login works without a password hash.
$privateEnv = Join-Path $PSScriptRoot '.env.napcat'
if (Test-Path -LiteralPath $privateEnv) {
  foreach ($line in (Get-Content -LiteralPath $privateEnv -Encoding UTF8)) {
    if ($line -match '^\s*(NAPCAT_QUICK_ACCOUNT|NAPCAT_QUICK_PASSWORD_MD5)\s*=\s*(.*?)\s*$' -and $Matches[2]) {
      [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"').Trim("'"), 'Process')
    }
  }
}
$moduleUri = ([uri]$mainScript).AbsoluteUri | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($env:NAPCAT_LOAD_PATH, "(async () => {await import($moduleUri)})()", (New-Object System.Text.UTF8Encoding($false)))
$logFile = Join-Path $installRoot 'napcat-console.log'
Set-Location -LiteralPath $installRoot
Add-Content -LiteralPath $logFile -Value ('NapCat launch {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
if ($env:NAPCAT_QUICK_ACCOUNT) { & $bootExe $qqExe $hookDll $env:NAPCAT_QUICK_ACCOUNT >> $logFile 2>&1 }
else { & $bootExe $qqExe $hookDll >> $logFile 2>&1 }
exit $LASTEXITCODE
