// 离线：控制台「QQ 登录」的 LLBot WebUI 代理（不联网、不碰真实账号）
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createLlbotWebui } from '../src/llbotWebui.js'
import { createNapcatWebui } from '../src/napcatWebui.js'
import { createAdminServer } from '../src/admin/server.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'llbot-webui-'))
const tokenFile = path.join(dir, 'webui_token.txt')
writeFileSync(tokenFile, 'test-password\n')
const expectedToken = createHash('sha256').update('test-password').digest('hex')

const calls = []
const fetchImpl = async (url, opts = {}) => {
  calls.push({ url, opts })
  if (url.endsWith('/api/login-info')) return { ok: true, status: 200, json: async () => ({ success: true, data: { uin: '10001', nick: '测试号', online: true } }) }
  if (url.endsWith('/api/quick-login-list')) return { ok: true, status: 200, json: async () => ({ success: true, data: { LocalLoginInfoList: [{ uin: '10001', nickName: '测试号' }, { uin: '10002', nickName: '备用号' }] } }) }
  if (url.endsWith('/api/quick-login')) return { ok: true, status: 200, json: async () => ({ success: true, data: { result: '0' } }) }
  if (url.endsWith('/api/logout')) return { ok: true, status: 200, json: async () => ({ success: true }) }
  if (url.endsWith('/api/login-qrcode')) return { ok: true, status: 200, json: async () => ({ success: true, data: { pngBase64QrcodeData: 'iVBORw0KGgo=', expireTime: 1700000000 } }) }
  return { ok: false, status: 404, json: async () => ({ success: false, message: 'not found' }) }
}

let pass = 0
const check = (name, ok) => {
  assert.ok(ok, name)
  pass++
  console.log('PASS', name)
}

const webui = createLlbotWebui({ baseUrl: 'http://127.0.0.1:3080', tokenFile, fetchImpl })
check('找到密码文件即视为可用', webui.status().available === true)

const info = await webui.info()
check('读取当前账号', info.uin === '10001' && info.online === true)
check('请求带哈希后的密码头', calls[0].opts.headers['X-Webui-Token'] === expectedToken)
check('请求头里没有明文密码', JSON.stringify(calls[0].opts.headers).includes('test-password') === false)

const accounts = await webui.accounts()
check('读取已保存账号', accounts.LocalLoginInfoList.length === 2)

const qr = await webui.qrcode()
check('二维码转成 data URL', qr.image.startsWith('data:image/png;base64,'))
check('二维码过期时间透传', qr.expireAt === 1700000000)

await webui.quickLogin(10002)
check('切换账号按字符串传 uin', JSON.parse(calls.at(-1).opts.body).uin === '10002')
check('切换账号是 POST', calls.at(-1).opts.method === 'POST')

await webui.logout()
check('退出登录是 POST /api/logout', calls.at(-1).opts.method === 'POST' && calls.at(-1).url.endsWith('/api/logout'))

const broken = createLlbotWebui({ baseUrl: 'http://127.0.0.1:3080', tokenFile, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ success: false, message: '服务不可用' }) }) })
check('LLBot 未登录时报错由 info 吞掉返回 null', (await broken.info()) === null)
check('其它接口失败时抛出 LLBot 的错误信息', await broken.accounts().then(() => false, (e) => /服务不可用/.test(e.message)))

const none = createLlbotWebui({ baseUrl: 'http://127.0.0.1:3080', tokenFile: path.join(dir, 'nope.txt'), fetchImpl })
check('没有密码文件时不可用', none.status().available === false)
check('没有密码文件时调用直接报错', await none.accounts().then(() => false, (e) => /webui_token/.test(e.message)))

const config = { dataDir: dir, logDir: dir, envFile: path.join(dir, '.env'), personaDir: path.join(dir, 'personas'), rootDir: dir, adminPort: 0, persona: '' }
const admin = createAdminServer({ config, llbotWebui: webui })
const state = await admin.actions['qq-login-state']()
check('控制台返回当前账号', state.available === true && state.current.uin === '10001' && state.current.online === true)
check('控制台标记当前账号', state.accounts.find((a) => a.current)?.uin === '10001')
check('切换账号拒绝非法 QQ 号', await admin.actions['qq-switch-account']({ uin: 'abc' }).then(() => false, (e) => /QQ 号无效/.test(e.message)))

const unconfigured = createAdminServer({ config, llbotWebui: null })
const off = await unconfigured.actions['qq-login-state']()
check('没有 LLBot 代理时返回 available:false', off.available === false && off.accounts.length === 0)

// ===== NapCat 后端 =====
const napcatDir = path.join(dir, 'napcat')
mkdirSync(path.join(napcatDir, 'config'), { recursive: true })
writeFileSync(path.join(napcatDir, 'config', 'webui.json'), JSON.stringify({ host: '127.0.0.1', port: 6099, token: 'nap-token' }))
const napCalls = []
const napFetch = async (url, opts = {}) => {
  napCalls.push({ url, opts })
  if (url.includes('/api/QQLogin/CheckLoginStatus')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, uin: '20002', nick: '备用号' } }) }
  if (url.includes('/api/QQLogin/GetQuickLoginList')) return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ uin: '20001', nick: '主号' }, { uin: '20002', nick: '备用号' }] }) }
  if (url.includes('/api/QQLogin/GetQQLoginQrcode')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { qrcode: 'iVBORw0KGgo=' } }) }
  if (url.includes('/api/QQLogin/SetQuickLogin')) return { ok: true, status: 200, json: async () => ({ code: 0 }) }
  if (url.includes('/api/QQLogin/Logout')) return { ok: true, status: 200, json: async () => ({ code: 0 }) }
  return { ok: false, status: 404, json: async () => ({ code: 404, message: 'not found' }) }
}
const napcat = createNapcatWebui({ napcatDir, fetchImpl: napFetch })
check('NapCat 从 config/webui.json 读取地址与 token', napcat.status().available === true && /6099/.test(napcat.status().baseUrl))
check('NapCat 当前账号', (await napcat.info()).uin === '20002')
check('NapCat token 走 query', napCalls[0].url.includes('token=nap-token'))
check('NapCat 账号列表归一化', (await napcat.accounts()).LocalLoginInfoList.length === 2)
check('NapCat 二维码转 data URL', (await napcat.qrcode()).image.startsWith('data:image/png;base64,'))
await napcat.quickLogin('20001')
check('NapCat 切换账号 body 带 uin', JSON.parse(napCalls.at(-1).opts.body).uin === '20001')
const napErr = createNapcatWebui({ baseUrl: 'http://127.0.0.1:6099', token: 'x', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 100, message: '未登录' }) }) })
check('NapCat 未登录时 info 返回 null', (await napErr.info()) === null)
check('NapCat 错误码转成错误信息', await napErr.accounts().then(() => false, (e) => /未登录/.test(e.message)))
const adminNap = createAdminServer({ config, loginProvider: napcat })
check('控制台标记 NapCat 后端', (await adminNap.actions['qq-login-state']()).provider === 'napcat')

rmSync(dir, { recursive: true, force: true })
console.log(`qq login checks passed: ${pass}`)
