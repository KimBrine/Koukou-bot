import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * NapCat WebUI 的登录代理（换号/扫码）。
 *
 * 和 LLBot 的差别：NapCat 的 WebUI token 是明文放在 config/webui.json 里，
 * 接口放在 /api/QQLogin/*，统一返回 { code, message, data }，token 走 query 或 Bearer。
 *
 * 注意：这里是对着 NapCat v4 WebUI 的公开接口写的，本机没有装 NapCat 时无法实测；
 * 一旦接口对不上，错误信息会把 HTTP 状态和返回体带出来，方便按实际版本调整。
 */
export function createNapcatWebui({ baseUrl = '', napcatDir = '', token = '', fetchImpl = (...args) => fetch(...args), logger = null } = {}) {
  let cached = null
  let triedConfig = ''

  function config() {
    if (cached) return cached
    let resolved = { baseUrl: String(baseUrl || '').replace(/\/+$/, ''), token: String(token || '') }
    if (napcatDir) {
      const file = path.join(napcatDir, 'config', 'webui.json')
      triedConfig = file
      try {
        if (existsSync(file)) {
          const data = JSON.parse(readFileSync(file, 'utf8'))
          if (!resolved.token) resolved.token = String(data.token || '')
          if (!resolved.baseUrl) resolved.baseUrl = `http://${data.host || '127.0.0.1'}:${Number(data.port) || 6099}`
        }
      } catch (err) {
        logger?.warn?.(`[QQ登录] 读取 NapCat WebUI 配置失败：${err.message}`)
      }
    }
    cached = resolved
    return cached
  }

  function status() {
    const c = config()
    return { available: Boolean(c.baseUrl && c.token), baseUrl: c.baseUrl, tokenFile: triedConfig, tried: triedConfig ? [triedConfig] : [] }
  }

  async function call(pathname, { method = 'POST', body } = {}) {
    const c = config()
    if (!c.baseUrl || !c.token) throw new Error('没有配置 NapCat WebUI（需要 NAPCAT_DIR 或 NAPCAT_WEBUI_URL + NAPCAT_WEBUI_TOKEN）')
    const url = `${c.baseUrl}${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(c.token)}`
    const headers = { Authorization: `Bearer ${c.token}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || (data && data.code !== undefined && data.code !== 0)) {
      const extra = data && (data.message || data.msg)
      throw new Error(extra || `NapCat WebUI 返回 HTTP ${res.status}`)
    }
    return data?.data
  }

  function account(item = {}) {
    return { uin: String(item.uin || item.uid || ''), nick: String(item.nick || item.nickname || item.name || ''), face: String(item.avatar || item.faceUrl || '') }
  }

  return {
    name: 'napcat',
    status,
    async info() {
      try {
        const data = await call('/api/QQLogin/CheckLoginStatus', { method: 'GET' })
        if (!data || data.isLogin === false || !data.uin) return null
        return { uin: String(data.uin || ''), nick: String(data.nick || data.nickname || ''), online: data.isLogin !== false }
      } catch (err) {
        if (/未登录|not.?login/i.test(err.message)) return null
        throw err
      }
    },
    async accounts() {
      const data = await call('/api/QQLogin/GetQuickLoginList')
      const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
      return { LocalLoginInfoList: list.map(account) }
    },
    quickLogin: (uin) => call('/api/QQLogin/SetQuickLogin', { method: 'POST', body: { uin: String(uin) } }),
    logout: () => call('/api/QQLogin/Logout', { method: 'POST' }),
    async qrcode() {
      const data = await call('/api/QQLogin/GetQQLoginQrcode', { method: 'GET' })
      const raw = String(data?.pngBase64QrcodeData || data?.qrcode || data?.url || '')
      if (!raw) throw new Error('NapCat 没有返回二维码数据（接口格式可能随版本变化）')
      const image = raw.startsWith('http') || raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`
      return { image, expireAt: Number(data?.expireTime) || 0 }
    },
  }
}
