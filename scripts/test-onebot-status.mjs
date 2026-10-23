// 离线去抖：LLBot 协议层抖动几秒内恢复时，不应把状态翻成离线
import assert from 'node:assert/strict'
import { OneBotClient } from '../src/onebot.js'

const logs = []
const logger = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) }
const client = new OneBotClient({ url: 'ws://127.0.0.1:1', logger })
client.ws = { readyState: 1 }
client.qqOnline = true
client.qqGood = true
client.probeVerified = true
client.probeCheckedAt = Date.now()
client.statusCheckedAt = Date.now()

let pass = 0
const check = (name, ok) => { assert.ok(ok, name); pass++; console.log('PASS', name) }

client.updateAccountStatus({ online: false, good: true })
check('刚断开 1 次不判离线', client.status().qqOnline === true && !logs.some((l) => l.includes('离线')))

client.offlineSince = Date.now() - 9000
client.updateAccountStatus({ online: false, good: true })
check('超过宽限期仍离线才判定离线', client.status().qqOnline === false && logs.some((l) => l.includes('离线')))

client.updateAccountStatus({ online: true, good: true })
check('恢复后立即回到在线', client.qqOnline === true && logs.some((l) => l.includes('在线')) && client.offlineSince === 0)

client.offlineSince = Date.now() - 2000
client.updateAccountStatus({ online: false, good: true })
client.updateAccountStatus({ online: true, good: true })
check('抖动来回后不残留离线计数', client.offlineSince === 0 && client.qqOnline === true)

console.log(`onebot status debounce checks passed: ${pass}`)
