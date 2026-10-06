import { createTargetWatch } from '../src/targetWatch.js'

const sent = []
const pushed = []
const chatCalls = []

const config = {
  targetWatchEnabled: true,
  targetWatchGroup: '1121936348',
  targetWatchUser: '1279630177',
  targetWatchIntervalMs: 15000,
}
const logger = { debug: () => {}, info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) }
const onebot = { sendGroup: async (gid, msg) => { sent.push({ gid, msg }) } }
const llm = { chat: async (prompt, history) => { chatCalls.push({ prompt, history }); return '好耶，你说得对awa🍥' } }
const memory = { get: () => [], push: (k, role, content) => pushed.push({ k, role, content }) }
const buildSystemPrompt = () => '系统提示（人设）'
const replyLog = new Map()

const watch = createTargetWatch({ config, logger, onebot, llm, memory, buildSystemPrompt, replyLog })
console.log('启用状态:', watch.enabled, '| 群:', watch.groupId, '| 用户:', watch.userId)

const evt = (gid, uid, atBot = false) => ({ message_type: 'group', group_id: Number(gid), user_id: Number(uid), message_id: Math.floor(Math.random() * 1e9), time: Math.floor(Date.now() / 1000) })

console.log('\n=== 1. 其他用户发言（不应记录）===')
watch.note(evt(1121936348, 999999), { text: '别人说的话', atBot: false })
console.log('待处理:', watch.pendingCount(), watch.pendingCount() === 0 ? '✅' : '❌')

console.log('\n=== 2. 目标用户 @ 机器人（不应记录，交给主流程）===')
watch.note(evt(1121936348, 1279630177, true), { text: '@机器人 你好', atBot: true })
console.log('待处理:', watch.pendingCount(), watch.pendingCount() === 0 ? '✅' : '❌')

console.log('\n=== 3. 目标用户普通发言（应记录）===')
watch.note(evt(1121936348, 1279630177), { text: '今天好累啊', atBot: false })
watch.note(evt(1121936348, 1279630177), { text: '你们在干嘛', atBot: false })
console.log('待处理:', watch.pendingCount(), watch.pendingCount() === 2 ? '✅' : '❌')

console.log('\n=== 4. 触发 tick（应 @ 他并发送一两句）===')
await watch.tick()
console.log('发送内容:', JSON.stringify(sent[0]))
const ok4 = sent.length === 1 && sent[0].msg[0].type === 'at' && sent[0].msg[0].data.qq === '1279630177' && sent[0].msg[1].data.text.includes('好耶')
console.log(ok4 ? '✅ 正确 @ 目标用户并附上回复' : '❌ 格式不对')
console.log('待处理已清空:', watch.pendingCount() === 0 ? '✅' : '❌')
console.log('已写入记忆:', pushed.length === 1 && pushed[0].role === 'assistant' ? '✅' : '❌')

console.log('\n=== 5. 主流程回了 A，随后他又发了 B（只跳过 A，B 必须被回应）===')
const evtA = evt(1121936348, 1279630177)
watch.note(evtA, { text: 'A：这条主流程会回复', atBot: false })
watch.markReplied(evtA.message_id)
const evtB = evt(1121936348, 1279630177)
watch.note(evtB, { text: 'B：这条必须被盯人回复', atBot: false })
const before = sent.length
await watch.tick()
console.log('本轮发送条数:', sent.length - before)
console.log(sent.length === before + 1 ? '✅ B 被正确回应，A 被跳过（不再吞掉新消息）' : '❌ 行为不对')
console.log('本轮发送内容:', JSON.stringify(sent.at(-1)?.msg))
console.log('待处理已清空:', watch.pendingCount() === 0 ? '✅' : '❌')

console.log('\n=== 6. 关闭开关时不应记录 ===')
const watch2 = createTargetWatch({ config: { ...config, targetWatchEnabled: false }, logger, onebot, llm, memory, buildSystemPrompt, replyLog })
watch2.note(evt(1121936348, 1279630177), { text: '测试', atBot: false })
console.log('待处理:', watch2.pendingCount(), watch2.pendingCount() === 0 ? '✅' : '❌')
process.exit(0)
