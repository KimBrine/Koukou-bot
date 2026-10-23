// 只输出启动所需的非敏感端口；读取与机器人相同的实例设置。
import { loadConfig } from '../src/config.js'
const config = loadConfig()
const url = new URL(config.onebotWsUrl)
if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !['ws:','wss:'].includes(url.protocol))
  throw new Error('LLBot 一键入口只用于本地 OneBot；远程连接请使用普通机器人入口')
const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80))
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('OneBot 端口无效')
console.log('ONEBOT_PORT=' + port)
console.log('CONSOLE_PORT=' + config.adminPort)
// 有配置账号时让 LLBot 直接用保存的登录态恢复，避免每次重启都退到扫码
if (config.llbotQq) console.log('LLBOT_QQ=' + config.llbotQq)
// 需要抓协议层断开原因时，启动器会给 LLBot 加 --debug
if (config.llbotDebug) console.log('LLBOT_DEBUG=1')
