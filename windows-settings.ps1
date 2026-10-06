function Get-KoukouWindowsSettings {
  $root = $PSScriptRoot
  $settingsFile = Join-Path $root 'windows.local.json'
  $local = if (Test-Path -LiteralPath $settingsFile) { Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  function Resolve-SettingPath([string]$value, [string]$fallback) {
    if (-not $value) { $value = $fallback }
    if (-not [IO.Path]::IsPathRooted($value)) { $value = Join-Path $root $value }
    return [IO.Path]::GetFullPath($value)
  }
  return [pscustomobject]@{
    Root = $root
    BotEnvFile = Resolve-SettingPath ([string]$local.botEnvFile) '.env'
    BotProfile = $(if ($local.botProfile) { [string]$local.botProfile } else { 'main' })
    BotTaskName = $(if ($local.botTaskName) { [string]$local.botTaskName } else { 'DeepSeekQQBot' })
    NapCatDir = $(if ($local.napcatDir) { Resolve-SettingPath ([string]$local.napcatDir) '' } else { '' })
    NapCatTaskName = $(if ($local.napcatTaskName) { [string]$local.napcatTaskName } else { 'NapCatQQ' })
  }
}
