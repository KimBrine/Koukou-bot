const ws = new WebSocket('ws://127.0.0.1:3001')
const timer = setTimeout(() => { console.log('超时：连不上 OneBot'); process.exit(2) }, 15000)
ws.onopen = () => {
  ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'probe' }))
}
ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data)
  if (d.echo === 'probe') {
    clearTimeout(timer)
    console.log('OneBot 登录状态:', JSON.stringify(d))
    process.exit(d.status === 'ok' ? 0 : 1)
  }
}
ws.onerror = () => { clearTimeout(timer); console.log('WebSocket 连接失败'); process.exit(3) }
