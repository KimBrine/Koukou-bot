function Get-NapCatConnection([string]$EnvFile) {
  $url = 'ws://127.0.0.1:3001'
  $accessToken = ''
  foreach ($line in (Get-Content -LiteralPath $EnvFile -Encoding UTF8)) {
    if ($line -match '^\s*ONEBOT_WS_URL\s*=\s*(.+)') { $url = $Matches[1].Trim().Trim('"').Trim("'") }
    if ($line -match '^\s*ONEBOT_ACCESS_TOKEN\s*=\s*(.*)') { $accessToken = $Matches[1].Trim().Trim('"').Trim("'") }
  }
  return [pscustomobject]@{ Url = $url; AccessToken = $accessToken }
}

function Get-NapCatQQStatus([string]$WsUrl, [string]$AccessToken = '', [int]$TimeoutMs = 1800, [string]$AdminUrl = 'http://127.0.0.1:8787') {
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  $cancel = New-Object System.Threading.CancellationTokenSource
  $cancel.CancelAfter($TimeoutMs)
  try {
    if ($AccessToken) {
      $separator = if ($WsUrl.Contains('?')) { '&' } else { '?' }
      $WsUrl += $separator + 'access_token=' + [uri]::EscapeDataString($AccessToken)
    }
    [void]$socket.ConnectAsync([uri]$WsUrl, $cancel.Token).GetAwaiter().GetResult()
    $request = [System.Text.Encoding]::UTF8.GetBytes('{"action":"get_status","params":{},"echo":"launcher-status"}')
    $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$request)
    [void]$socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 16384
    while (-not $cancel.IsCancellationRequested) {
      $stream = New-Object System.IO.MemoryStream
      try {
        do {
          $receiveBuffer = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$buffer)
          $received = $socket.ReceiveAsync($receiveBuffer, $cancel.Token).GetAwaiter().GetResult()
          if ($received.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { throw 'OneBot connection closed' }
          $stream.Write($buffer, 0, $received.Count)
          if ($stream.Length -gt 65536) { throw 'Unexpected status response size' }
        } while (-not $received.EndOfMessage)
        $packet = [System.Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($packet.echo -ne 'launcher-status') { continue }
        if ($packet.status -ne 'ok' -or $packet.data.online -isnot [bool]) { throw 'QQ status response unavailable' }
        $verified = $false
        if ($packet.data.online) {
          # OneBot 心跳与 get_status 共用 NapCat 的内存值，不能作为真实 QQ 连接证明。
          try {
            $adminState = Invoke-RestMethod -Uri ($AdminUrl.TrimEnd('/') + '/api/state') -TimeoutSec 2
            $reportedUri = [uri]$adminState.bot.onebotUrl
            $requestedUri = [uri]$WsUrl
            $verified = $reportedUri.Host -eq $requestedUri.Host -and $reportedUri.Port -eq $requestedUri.Port -and $adminState.bot.probeVerified -eq $true -and $adminState.bot.online -eq $true
          } catch { $verified = $false }
        }
        return [pscustomobject]@{ Confirmed=$true; Online=$packet.data.online; Verified=$verified; Good=$packet.data.good; Error=''; CheckedAt=[DateTime]::UtcNow }
      } finally { $stream.Dispose() }
    }
    throw 'QQ status check timed out'
  } catch {
    return [pscustomobject]@{ Confirmed=$false; Online=$null; Good=$null; Error='QQ 在线状态暂时无法确认，请打开登录页检查。'; CheckedAt=$null }
  } finally {
    $socket.Abort()
    $socket.Dispose()
    $cancel.Dispose()
  }
}

function Get-NapCatAccountDisplay($Health) {
  if ($Health.Confirmed -and $Health.Online -eq $true -and $Health.Verified -eq $true -and $Health.Good -ne $false) {
    return [pscustomobject]@{Text='●  QQ 在线，可以使用'; Color='online'; Details='QQ 在线状态已核对。'}
  }
  if ($Health.Confirmed -and $Health.Online -eq $false) {
    return [pscustomobject]@{Text='●  QQ 已离线'; Color='offline'; Details='NapCat 仍在运行，但 QQ 账号已掉线。请打开登录页重新登录或查看原因。'}
  }
  if ($Health.Confirmed -and $Health.Online -eq $true) {
    return [pscustomobject]@{Text='●  QQ 实际连接待核验'; Color='unknown'; Details='NapCat 报告在线，但实际 QQ 请求尚未核验成功。请打开控制台查看连接详情。'}
  }
  return [pscustomobject]@{Text='●  QQ 状态未确认'; Color='unknown'; Details='尚未确认 QQ 账号在线，请打开登录页检查。'}
}
