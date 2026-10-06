function Get-KoukouLauncherSettings {
  $settingsFile = Join-Path $PSScriptRoot 'launcher.local.json'
  if (-not (Test-Path -LiteralPath $settingsFile)) {
    throw 'Copy launcher.example.json to launcher.local.json and set your NapCat installation directory.'
  }
  $settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $settings.napcatDir) { throw 'napcatDir is required in launcher.local.json.' }
  $envPath = [string]$settings.botEnvFile
  if (-not $envPath) { $envPath = '../../.env' }
  if (-not [System.IO.Path]::IsPathRooted($envPath)) { $envPath = Join-Path $PSScriptRoot $envPath }
  return [pscustomobject]@{
    NapCatDir = [System.IO.Path]::GetFullPath([string]$settings.napcatDir)
    BotEnvFile = [System.IO.Path]::GetFullPath($envPath)
    TaskName = $(if ($settings.taskName) { [string]$settings.taskName } else { 'NapCatQQ' })
    Account = [string]$settings.account
  }
}
