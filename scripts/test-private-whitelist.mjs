import assert from 'node:assert/strict'
import { decideReply } from '../src/bot.js'

const config = {
  mutedGroups: new Set(), whitelistGroups: new Set(),
  quietHoursBlockAll: false, quietHours: '',
  proactiveRate: 0, adminUsers: '100', privateWhitelist: new Set([200]),
}
const none = { get: () => ({}), raw: () => null }
const r = (key, cs = none) => decideReply({ isPrivate: true, atBot: false, config, chatSettings: cs, chatKey: key })

assert.equal(r('p999').reply, false, '陌生人私聊不能回')
assert.equal(r('p200').reply, true, '白名单内要回')
assert.equal(r('p100').reply, true, '管理员要回')
const configured = { get: () => ({}), raw: (k) => (k === 'p999' ? { enabled: true } : null) }
assert.equal(r('p999', configured).reply, true, '控制台加过的私聊要回')
config.privateWhitelist = new Set()
assert.equal(r('p999').reply, false, '清空白名单后陌生人仍不回')
console.log('私聊白名单检查通过：陌生人静默 / 白名单与管理放行 / 已添加私聊放行')
