import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

/**
 * LLBot（LuckyLillia）WebUI 的只读/登录代理。
 *
 * 为什么需要：机器人进程本身不管理 QQ 登录，登录态在 LLBot 里；
 * 换号要调 LLBot 的 WebUI 接口（3080）。这里只做三件事：找密码、签名、转发。
 * 密码文件是 LLBot 自己写的 webui_token.txt，请求头要的是它的 sha256（不是明文）。
 */
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')

export function createLlbotWebui({ baseUrl = 'http://127.0.0.1:3080', tokenFile = '', candidates = [], fetchImpl = (...args) => fetch(...args), logger = null } = {}) {
  const tokenCandidates = [tokenFile, ...candidates].filter(Boolean)
  let cached = null
  const tried = []

  function resolveToken() {
    if (cached) return cached
    for (const file of tokenCandidates) {
      tried.push(file)
      try {
        if (!existsSync(file)) continue
        const text = readFileSync(file, 'utf8').trim()
        if (text) { cached = text; return cached }
      } catch (err) {
        logger?.warn?.(`[QQ登录] 读取 LLBot 密码文件失败：${file}（${err.message}）`)
      }
    }
    return ''
  }

  function status() {
    const token = resolveToken()
    return { available: Boolean(token && baseUrl), baseUrl, tokenFile: token ? tokenFile || tokenCandidates.find((f) => existsSync(f)) : '', tried }
  }

  async function call(pathname, { method = 'GET', body } = {}) {
    const token = resolveToken()
    if (!token) throw new Error('没找到 LLBot 的 webui_token.txt，请在 .env 配置 LLBOT_WEBUI_TOKEN_FILE')
    const headers = { 'X-Webui-Token': hash(token) }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetchImpl(`${baseUrl}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.success === false) {
      throw new Error(data?.message || `LLBot WebUI 返回 HTTP ${res.status}`)
    }
    return data.data
  }

  return {
    status,
    /** 当前登录账号；未登录时 LLBot 会报错，这里按"未登录"返回 null 而不是抛错 */
    async info() {
      try { return await call('/api/login-info') } catch { return null }
    },
    accounts: () => call('/api/quick-login-list'),
    quickLogin: (uin) => call('/api/quick-login', { method: 'POST', body: { uin: String(uin) } }),
    logout: () => call('/api/logout', { method: 'POST' }),
    async qrcode() {
      const data = await call('/api/login-qrcode')
      const png = data?.pngBase64QrcodeData || ''
      if (!png) throw new Error('LLBot 没有返回二维码数据')
      return { image: png.startsWith('data:') ? png : `data:image/png;base64,${png}`, expireAt: Number(data?.expireTime) || 0 }
    },
  }
}
