/**
 * 定时指令「记得自己做过什么」的确定性验证：
 *   1) 发出去的指令必须写进记忆（否则机器人不知道自己说过 → "抽完就忘"）
 *   2) 抽到结果后要落盘"今日已办"，供系统提示词注入（群聊刷屏后也不会忘）
 *   3) 链式补发只在该触发时才触发
 *
 *   node scripts/test-daily-ping-flow.mjs
 * 全程用假的 onebot / memory，不联网、不发消息。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDailyPing } from '../src/dailyPing.js'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${extra ? `　${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? `　${extra}` : ''}`)
  }
}

const GROUP = '801944160'
const TARGET = '3889001246'

function makeEnv({ match = '抓到.*猪猪', chainText = '/我的猪圈', sendDelayMs = 0 } = {}) {
  const sent = []
  const memory = { items: [], push(key, role, content) { this.items.push({ key, role, content }) } }
  const onebot = {
    selfId: '3883059067',
    async sendGroup(groupId, message) {
      if (sendDelayMs) await new Promise((resolve) => setTimeout(resolve, sendDelayMs))
      sent.push({ groupId: String(groupId), message })
      return { message_id: 1000 + sent.length }
    },
    async getGroupMemberInfo() {
      return { card: '幽幽子', nickname: '幽幽子' }
    },
    async getGroupMsgHistory() {
      return { messages: [] }
    },
  }
  const config = {
    dailyPingEnabled: true,
    dailyPingTime: '00:00',
    dailyPingGroup: GROUP,
    dailyPingTarget: TARGET,
    dailyPingText: '/今日猪猪',
    dailyPingChainEnabled: true,
    dailyPingChainText: chainText,
    dailyPingChainWindowMs: 90000,
    dailyPingChainMatch: match,
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dp-'))
  const stateFile = path.join(dir, 'state.json')
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`), error: (m) => logs.push(`ERR ${m}`), debug: () => {} }
  const logs = []
  const dp = createDailyPing({ config, logger, onebot, rateLimiter: null, memory, stateFile })
  return { dp, sent, memory, stateFile, logs, dir, config }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 构造一条"幽幽子"的群消息 */
const fromPig = (text) => [{ group_id: GROUP, user_id: TARGET, message_type: 'group' }, { text }]

console.log('\n=== 1. 发出去的指令要写进记忆（"抽完就忘"的根因）===')
{
  const env = makeEnv()
  const okSend = await env.dp.sendNow('自测')
  ok('主指令发送成功', okSend === true, `→ ${env.sent.length} 条已发`)
  ok('发送内容带真实 at 段', env.sent[0].message[0].type === 'at' && env.sent[0].message[0].data.qq === TARGET)
  ok('正文是「空格 + /今日猪猪」', env.sent[0].message[1].data.text === ' /今日猪猪')
  const mem = env.memory.items.filter((m) => m.role === 'assistant')
  ok('机器人自己的指令已写入记忆', mem.length === 1, `→ ${JSON.stringify(mem[0]?.content)}`)
  ok('记忆里是自然写法（用昵称不是号码）', /^@幽幽子 \/今日猪猪$/.test(mem[0]?.content ?? ''), `→ ${mem[0]?.content}`)
  ok('写入的是本群的会话 key', mem[0]?.key === `g${GROUP}`)
  rmSync(env.dir, { recursive: true, force: true })
}

console.log('\n=== 2. 抽到结果 → 落盘"今日已办" + 注入提示词 ===')
{
  const env = makeEnv()
  ok('抽之前没有今日提示', env.dp.todayNote(`g${GROUP}`) === '')
  await env.dp.sendNow('自测')
  // 幽幽子成功回应
  await env.dp.noteMessage(...fromPig('@Koukou\\. 🎉 抓到一只新猪猪啦！ 【柠檬猪】 酸酸甜甜 > 你…'))
  ok('识别出抽到的猪名', /柠檬猪/.test(env.dp.todayNote(`g${GROUP}`)), `→ ${env.dp.todayNote(`g${GROUP}`).trim()}`)
  ok('新猪明确为首次获得', /第一次获得这只猪/.test(env.dp.todayNote(`g${GROUP}`)))
  ok('提示词里明确"别再说没做过"', /别再说没做过/.test(env.dp.todayNote(`g${GROUP}`)))
  ok('状态已落盘', readFileSync(env.stateFile, 'utf8').includes('柠檬猪'))
  ok('别的群不受影响', env.dp.todayNote('g999') === '')

  // 链式补发后，状态里应记上"查过猪圈"
  await sleep(4200)
  const follow = env.sent.find((s) => s.message[1]?.data?.text === ' /我的猪圈')
  ok('链式补发已发出', Boolean(follow), `→ ${env.sent.length} 条已发`)
  ok('补发的指令也写进记忆', env.memory.items.some((m) => m.content === '@幽幽子 /我的猪圈'))
  ok('状态里记上"查过猪圈"', /查过「我的猪圈」/.test(env.dp.todayNote(`g${GROUP}`)))
  rmSync(env.dir, { recursive: true, force: true })
}

console.log('\n=== 3. 重启后仍记得（状态从文件恢复）===')
{
  const env = makeEnv()
  await env.dp.sendNow('自测')
  await env.dp.noteMessage(...fromPig('💫 这是你第2次抓到这只猪猪啦~ 【猪咪】Lv.2 你是一只可爱的猪咪！'))
  const note = env.dp.todayNote(`g${GROUP}`)
  ok('重复抽到时保留真实次数', /第2次获得这只猪/.test(note))
  // 新建一个实例，读同一个状态文件（模拟重启）
  const env2 = makeEnv()
  rmSync(env2.stateFile, { force: true })
  const { copyFileSync } = await import('node:fs')
  copyFileSync(env.stateFile, env2.stateFile)
  const { createDailyPing: make2 } = await import('../src/dailyPing.js')
  const dp2 = make2({
    config: env2.config,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onebot: { selfId: '1', async sendGroup() { return {} }, async getGroupMemberInfo() { return null } },
    rateLimiter: null,
    memory: null,
    stateFile: env2.stateFile,
  })
  ok('重启后仍记得今天抽过', /猪咪/.test(dp2.todayNote(`g${GROUP}`)), `→ ${dp2.todayNote(`g${GROUP}`).trim()}`)
  ok('两次记录一致', dp2.todayNote(`g${GROUP}`).length > 10 && note.length > 10)
  rmSync(env.dir, { recursive: true, force: true })
  rmSync(env2.dir, { recursive: true, force: true })
}

console.log('\n=== 4. 失败回应不该触发补发，也不该记成"已抽到" ===')
{
  const env = makeEnv()
  await env.dp.sendNow('自测')
  await env.dp.noteMessage(...fromPig('@Koukou\\. 🔍 今天已经抽过了哦~ 【酒鬼猪】 再来一瓶'))
  await sleep(1200)
  ok('没有补发', !env.sent.some((s) => s.message[1]?.data?.text === ' /我的猪圈'), `→ 共 ${env.sent.length} 条`)
  ok('仍在等待（窗口未到）', env.dp.pendingChain() !== null)
  rmSync(env.dir, { recursive: true, force: true })
}

console.log('\n=== 5. 目标账号的无关发言不会误触发 ===')
{
  const env = makeEnv()
  await env.dp.sendNow('自测')
  await env.dp.noteMessage(...fromPig('哈哈哈哈你们怎么都在抽猪猪'))
  await sleep(800)
  ok('闲聊不触发补发', !env.sent.some((s) => s.message[1]?.data?.text === ' /我的猪圈'))
  ok('别人的消息更不该触发', await (async () => {
    await env.dp.noteMessage({ group_id: GROUP, user_id: '999999' }, { text: '抓到一只新猪猪啦' })
    await sleep(600)
    return !env.sent.some((s) => s.message[1]?.data?.text === ' /我的猪圈')
  })())
  rmSync(env.dir, { recursive: true, force: true })
}

console.log('\n=== 6. 定时发送同一天只执行一次，重启也不会补发重复指令 ===')
{
  const env = makeEnv({ sendDelayMs: 30 })
  await Promise.all([
    env.dp.sendNow('定时触发', { oncePerDay: true }),
    env.dp.sendNow('启动补发', { oncePerDay: true }),
  ])
  ok('定时与补发并发时只发一条', env.sent.length === 1)
  ok('已发送但未抽中的提示不编造结果', /尚未确认抽取成功/.test(env.dp.todayNote(`g${GROUP}`)))
  await env.dp.sendNow('启动补发', { oncePerDay: true })
  ok('同一进程再次补发被跳过', env.sent.length === 1)
  const env2 = makeEnv()
  const { copyFileSync } = await import('node:fs')
  copyFileSync(env.stateFile, env2.stateFile)
  const dp2 = createDailyPing({ config: env2.config, logger: env2.logs, onebot: {
    async sendGroup() { env2.sent.push('sent'); return {} },
  }, stateFile: env2.stateFile })
  await dp2.sendNow('重启后补发', { oncePerDay: true })
  ok('重启后从磁盘识别今日已发送', env2.sent.length === 0)
  rmSync(env.dir, { recursive: true, force: true })
  rmSync(env2.dir, { recursive: true, force: true })
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
