/**
 * 主动搭话复现：把某个群当天的真实消息重放一遍，看"主动搭话"到底会不会触发、触发几次。
 *
 *   node scripts/test-proactive.mjs [群号] [天数] [模拟轮数]
 *
 * 逻辑与线上完全一致：decideReply（含白名单判定、安静时段、10% 概率、冷却）+ 每小时限流。
 * 因为概率判定是随机的，默认模拟 2000 遍取平均，得到"这种消息量下每天大约主动几次"。
 * 只读本地捕获数据，不联网、不发消息。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { decideReply } from '../src/bot.js'
import { createRateLimiter } from '../src/humanize.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = loadConfig()

const groupId = Number(process.argv[2] || 801944160)
const days = Math.max(1, Math.min(30, Number(process.argv[3]) || 1))
const ROUNDS = Math.max(1, Number(process.argv[4]) || 2000)

const pad2 = (n) => String(n).padStart(2, '0')
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

const records = []
for (let i = days - 1; i >= 0; i--) {
  const d = new Date()
  d.setDate(d.getDate() - i)
  const file = path.join(ROOT, 'data', 'daily', String(groupId), `${dateKey(d)}.jsonl`)
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* 跳过坏行 */
    }
  }
}
records.sort((a, b) => a.time - b.time)

console.log(`=== 群 ${groupId} 最近 ${days} 天：共 ${records.length} 条消息 ===`)
if (records.length === 0) {
  console.log('没有捕获数据（该群可能没进白名单，或消息都是图片/非文本）。')
  process.exit(0)
}

const spam = records.filter((r) => r.userId === String(config.ownerId ?? '')).length
const atBotCount = records.filter((r) => r.atBot).length
const withText = records.filter((r) => String(r.text ?? '').trim()).length
console.log(`  含文字的: ${withText} 条（只有这些会进入回复判定）`)
console.log(`  明确 @ 了机器人的: ${atBotCount} 条${atBotCount === 0 && days > 0 ? '（早期捕获没记这个字段，按未@处理，会让"主动"的估计偏高）' : ''}`)
console.log(`  时间跨度: ${new Date(records[0].time * 1000).toLocaleString('zh-CN', { hour12: false })} ~ ${new Date(records[records.length - 1].time * 1000).toLocaleString('zh-CN', { hour12: false })}`)
void spam

const messages = records.filter((r) => String(r.text ?? '').trim())
const totalByReason = new Map()
let proactiveTotal = 0
let atTotal = 0
let quietTotal = 0

for (let round = 0; round < ROUNDS; round++) {
  const lastProactive = new Map()
  const rateLimiter = createRateLimiter({ perHour: config.rateLimitPerHour, minGapMs: config.rateLimitMinGapMs })
  const key = `g${groupId}`
  for (const r of messages) {
    const now = r.time * 1000
    const decision = decideReply({
      isPrivate: false,
      atBot: Boolean(r.atBot),
      groupId,
      config,
      lastProactive,
      now,
    })
    totalByReason.set(decision.reason, (totalByReason.get(decision.reason) ?? 0) + 1)
    if (!decision.reply) continue
    // 与线上一致：决策通过后还要过限流
    const gate = rateLimiter.check(key, now)
    if (!gate.allowed) continue
    rateLimiter.record(key, now)
    if (decision.reason === '白名单群主动搭话') proactiveTotal++
    if (decision.reason === '群内被@') atTotal++
    if (decision.reason === '安静时段（只回 @）') quietTotal++
  }
}

console.log(`\n=== 模拟 ${ROUNDS} 遍（按真实消息时间轴）===`)
console.log(`  平均每 ${days} 天收到 ${messages.length} 条可判定消息`)
console.log(`  ★ 主动搭话触发: 平均 ${(proactiveTotal / ROUNDS).toFixed(2)} 次/${days} 天`)
console.log(`  被 @ 必回:      平均 ${(atTotal / ROUNDS).toFixed(2)} 次/${days} 天`)

console.log('\n  判定原因分布（每遍平均）:')
const rows = [...totalByReason.entries()].sort((a, b) => b[1] - a[1])
for (const [reason, n] of rows) {
  const avg = n / ROUNDS
  const pct = ((n / (messages.length * ROUNDS)) * 100).toFixed(1)
  console.log(`    ${reason.padEnd(18)} ${avg.toFixed(2).padStart(8)} 条/轮  (${pct}%)`)
}

const quietMins = config.quietHours || '（未启用）'
const rates = [...config.whitelistGroups]
  .map((g) => `${g}: ${(config.proactiveRateFor(g) * 100).toFixed(0)}%${config.proactiveRatePerGroup.has(g) ? '' : '(全局)'}`)
  .join('｜')
const myRate = config.proactiveRateFor(groupId)
console.log(`\n当前策略：白名单概率 ${rates}｜冷却 ${(config.proactiveCooldownMs / 1000).toFixed(0)}s｜安静时段 ${quietMins}`)
console.log(`本群 ${groupId} 生效概率：${(myRate * 100).toFixed(0)}%${config.proactiveRatePerGroup.has(groupId) ? '（单独配置）' : '（沿用全局 PROACTIVE_RATE）'}`)
console.log(`换算：这个群平均每天 ${(messages.length / days).toFixed(1)} 条消息 × ${(myRate * 100).toFixed(0)}% ≈ ${((messages.length / days) * myRate).toFixed(2)} 次主动/天（冷却与安静时段还会再削掉一些）`)
