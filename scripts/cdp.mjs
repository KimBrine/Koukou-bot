/**
 * 通过 CDP（Chrome DevTools 协议）驱动控制台页面：点元素、取页面状态、截图。
 * 比模拟鼠标可靠得多（不受 DPI / 窗口位置影响），也用于自动化回归验证。
 *
 *   node scripts/cdp.mjs shot  out.png            截图（整页）
 *   node scripts/cdp.mjs eval  "<js 表达式>"       在页面里求值并打印结果
 *   node scripts/cdp.mjs click "<css 选择器>"      点击第一个匹配元素
 *   node scripts/cdp.mjs text                     打印页面可见文字（前 4000 字）
 *
 * 需要 Edge 带 --remote-debugging-port=9223 启动（见 scripts/shot-console.ps1）。
 */
const PORT = Number(process.env.CDP_PORT || 9223)
const BASE = `http://127.0.0.1:${PORT}`

const [, , cmd, arg] = process.argv

async function findTarget() {
  const list = await (await fetch(`${BASE}/json/list`)).json()
  const pages = list.filter((t) => t.type === 'page')
  return pages.find((t) => /127\.0\.0\.1:\d+/.test(t.url)) ?? pages[0]
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let seq = 0
    const pending = new Map()
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = ++seq
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
            setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`CDP 超时：${method}`))), 20000)
          })
        },
        close: () => ws.close(),
      }),
    )
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
    })
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
    setTimeout(() => reject(new Error('CDP 连接超时')), 8000)
  })
}

const target = await findTarget()
if (!target) {
  console.error('没找到可调试的页面，请用 --remote-debugging-port 启动浏览器')
  process.exit(1)
}
const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')

if (cmd === 'eval' || cmd === 'click') {
  const expr = cmd === 'click' ? `(() => { const el = document.querySelector(${JSON.stringify(arg)}); if (!el) return 'NOT_FOUND'; el.click(); return 'CLICKED'; })()` : arg
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    console.error('页面执行出错：', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    process.exit(1)
  }
  console.log(JSON.stringify(r.result?.value ?? null))
  await new Promise((r2) => setTimeout(r2, 600))
} else if (cmd === 'text') {
  const r = await cdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })
  console.log(String(r.result?.value ?? '').slice(0, 4000))
} else if (cmd === 'shot') {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(arg, Buffer.from(r.data, 'base64'))
  console.log(`SHOT_OK ${arg}`)
} else {
  console.error('用法：cdp.mjs shot|eval|click|text <参数>')
  process.exit(1)
}

cdp.close()
process.exit(0)
