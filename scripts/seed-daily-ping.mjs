/**
 * 补录一次"今日已办"（用于修复上线之前已经发生过、但没被记录的抽猪）。
 *
 *   node scripts/test-daily-ping.mjs                     # 正常手动触发（会真的发消息）
 *   node scripts/seed-daily-ping.mjs 801944160 柠檬猪     # 补录：今天该群已抽到「柠檬猪」
 *
 * 做两件事：
 *   1. 写 data/daily-ping-state.json（注入系统提示词用，机器人当天不会再忘）
 *   2. 把两条指令补进记忆（data/memory.json），让它"记得自己说过"
 * ⚠️ 机器人运行时改 memory.json 会被内存版本覆盖，所以脚本会提示你先停机器人。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = loadConfig()

const groupId = String(process.argv[2] || config.dailyPingGroup || '')
const pig = String(process.argv[3] || '').trim()
if (!groupId) {
  console.error('用法：node scripts/seed-daily-ping.mjs <群号> [猪名]')
  process.exit(1)
}

const pad2 = (n) => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`

// 1. 今日状态
const stateFile = path.join(ROOT, 'data', 'daily-ping-state.json')
let state = {}
try {
  if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, 'utf8'))
} catch {
  state = {}
}
state[groupId] = { date: today, pig: pig || '', penAt: Date.now(), seededAt: Date.now() }
writeFileSync(stateFile, JSON.stringify(state, null, 2))
console.log(`✅ 已写入今日状态：${stateFile}`)
console.log(`   群 ${groupId}｜${today}｜抽到：${pig || '（未填）'}`)

// 2. 补记忆
const memoryFile = path.join(ROOT, 'data', 'memory.json')
const key = `g${groupId}`
try {
  const mem = existsSync(memoryFile) ? JSON.parse(readFileSync(memoryFile, 'utf8')) : {}
  const list = Array.isArray(mem[key]) ? mem[key] : []
  const target = config.dailyPingTarget
  const nick = String(process.argv[4] || '幽幽子')
  const entries = [`@${nick} ${config.dailyPingText}`, `@${nick} ${config.dailyPingChainText}`]
  for (const content of entries) {
    if (!list.some((m) => m.role === 'assistant' && m.content === content)) {
      list.push({ role: 'assistant', content })
    }
  }
  while (list.length > config.historyLimit) list.shift()
  mem[key] = list
  writeFileSync(memoryFile, JSON.stringify(mem, null, 2))
  console.log(`✅ 已补进记忆：${entries.join('、')}（@${target}）`)
  console.log('   ⚠️ 如果机器人正在运行，请立刻重启它，否则内存里的旧记忆会覆盖这次修改。')
} catch (err) {
  console.error(`补记忆失败：${err.message}`)
  process.exit(1)
}
