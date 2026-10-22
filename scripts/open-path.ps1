param([string]$Target)
$log = 'D:\QQ-bot\Koukou-bot\logs\open-path.log'
function W($m) { Add-Content -LiteralPath $log -Value ("[" + (Get-Date -Format 'HH:mm:ss') + "] " + $m) -Encoding UTF8 }
try {
  if (-not $Target) {
    $f = 'D:\QQ-bot\Koukou-bot\data\open-path.txt'
    if (Test-Path -LiteralPath $f) { $Target = (Get-Content -LiteralPath $f -Raw -Encoding UTF8).Trim() }
  }
  W ("target=" + $Target)
  if (-not $Target) { exit 0 }
  if (Test-Path -LiteralPath $Target -PathType Container) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $Target + '"')
    W "opened folder"
  } elseif (Test-Path -LiteralPath $Target) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + $Target + '"')
    W "selected file"
  } else {
    W "not found"
  }
} catch { W ("ERR " + $_.Exception.Message) }
