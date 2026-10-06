/**
 * 实测：回复长度自适应 + 多行分条。
 * 用**线上同一份提示词**（persona + chatAppendix + shapeHint）真实调用 DeepSeek，
 * 对不同长度的对方消息各跑若干轮，统计：长度是否跟着对方走、单行/多行比例、装饰符号频率。
 *
 *   node scripts/test-live-length.mjs            # 每种消息跑 3 轮
 *   node scripts/test-live-length.mjs --trials 5
 *
 * 只调用模型、不发送任何 QQ 消息。
 */
import { loadConfig } from '../src/config.js'
import { DeepSeekClient } from '../src/deepseek.js'
import { buildChatAppendix } from '../src/chatAppendix.js'
import { limitDecoration, hasDecoration } from '../src/humanize.js'
import { measureText, backlogLength, planReply, shapeReply, shapeHint } from '../src/replyShape.js'

const trialsArg = process.argv.indexOf('--trials')
const TRIALS = trialsArg >= 0 ? Math.max(1, Number(process.argv[trialsArg + 1]) || 3) : 3
const onlyArg = process.argv.indexOf('--only')
const ONLY = onlyArg >= 0 ? String(process.argv[onlyArg + 1] ?? '') : ''

const config = loadConfig()
const logger = {
  info: () => {},
  warn: (m) => console.log(`  [warn] ${m}`),
  error: (m) => console.log(`  [error] ${m}`),
  debug: () => {},
}
const llm = new DeepSeekClient({
  apiKey: config.deepseekApiKey,
  baseUrl: config.deepseekBaseUrl,
  model: config.deepseekModel,
  temperature: config.temperature,
  maxTokens: config.maxTokens,
  timeoutMs: config.timeoutMs,
  maxRetries: config.maxRetries,
  maxConcurrency: config.maxConcurrency,
  logger,
  label: 'DeepSeek',
})

// 群聊背景（让模型有上下文，但当前消息本身不放进 history）
const HISTORY = [
  { role: 'user', content: '【李四】今晚有人一起打游戏吗' },
  { role: 'assistant', content: '我在我在，几点开' },
  { role: 'user', content: '【王五】我可能得晚点' },
  { role: 'assistant', content: '那就等你' },
]

const CASES = [
  { name: '极短', text: '在吗' },
  { name: '短', text: '哈哈哈哈哈哈哈' },
  { name: '中短', text: '今天食堂的饭也太难吃了吧' },
  { name: '中', text: '我刚刚打完一把，队友全程挂机，我拿辅助打了四十分钟最后还是输了，真的服了这帮人' },
  {
    name: '长',
    text: '今天下午本来想早点把作业写完，结果室友非要拉我出去打球，打到六点多回来洗个澡吃个饭就八点了，现在坐在电脑前面一个字都没动，明天早八还要交，我现在就是非常后悔，早知道就不去了，你说我这算不算自作自受',
  },
  { name: '表情', text: '[表情:笑哭]' },
]

// 多条未回消息（连发场景）
const BACKLOG = [
  { role: 'user', content: '【李四】你们看今天那个新闻了吗' },
  { role: 'user', content: '【李四】就是那个球队换教练的事' },
  { role: 'user', content: '【王五】看了看了，感觉挺离谱的' },
]

const results = []

function buildPrompt(plan) {
  const time = new Date().toLocaleString('zh-CN', { hour12: false })
  return `${config.persona}${buildChatAppendix({ time })}${shapeHint(plan)}`
}

async function runCase(label, text, history, trial) {
  const incomingLen = measureText(text) || (text.includes('图片') ? 6 : 0)
  const backlogLen = backlogLength(history)
  const plan = planReply({
    incomingLen,
    backlogLen,
    maxLines: config.replyMaxLines,
    lineMaxChars: config.replyLineMaxChars,
    matchEnabled: config.replyLengthMatch,
  })
  const content = `【张三】${text}`
  let raw
  try {
    raw = await llm.chat(buildPrompt(plan), [...history, { role: 'user', content }])
  } catch (err) {
    console.log(`  ❌ ${label} 第 ${trial + 1} 轮调用失败：${err.message}`)
    return null
  }
  const lines = shapeReply(raw, plan)
  const sent = limitDecoration(lines.join('\n'), config.emojiKeepRate)
  const finalLines = sent.split('\n').map((s) => s.trim()).filter(Boolean)
  const replyLen = finalLines.join('').length

  console.log(`  【${label}】对方 ${incomingLen} 字「${text.slice(0, 24)}${text.length > 24 ? '…' : ''}」`)
  console.log(`     计划：${plan.lines} 行 / 预算 ${plan.budget} 字（目标 ${plan.targetLen}）`)
  console.log(`     实际：${finalLines.length} 条 / ${replyLen} 字　${finalLines.map((l) => `「${l}」`).join(' + ')}`)
  console.log(`     比例：${(replyLen / Math.max(1, incomingLen)).toFixed(2)}x　模型原始输出 ${raw.split('\n').length} 行/${raw.length} 字${hasDecoration(raw) ? '（含装饰）' : ''}`)

  return {
    label,
    incomingLen,
    plannedLines: plan.lines,
    budget: plan.budget,
    lines: finalLines.length,
    replyLen,
    rawLines: raw.split('\n').length,
    raw,
  }
}

console.log(`=== 实测回复长度自适应（模型 ${config.deepseekModel}，每种 ${TRIALS} 轮）===`)
console.log(`配置：最多 ${config.replyMaxLines} 行 / 单行 ≤${config.replyLineMaxChars} 字 / 长度自适应 ${config.replyLengthMatch ? '开' : '关'}\n`)

const ALL_CASES = [...CASES, { name: '连发3条', text: '看了看了，感觉挺离谱的', history: BACKLOG }]

for (const c of ALL_CASES) {
  if (ONLY && !c.name.includes(ONLY)) continue
  console.log(`\n── ${c.name} ──`)
  for (let t = 0; t < TRIALS; t++) {
    const r = await runCase(c.name, c.text, c.history ?? HISTORY, t)
    if (r) results.push(r)
  }
}

if (results.length === 0) {
  console.log('\n没有匹配的用例（--only 过滤后为空）。')
  process.exit(0)
}

// ── 统计 ────────────────────────────────────────────────────────────
console.log(`\n\n=== 统计（${results.length} 个样本）===`)
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)

const short = results.filter((r) => r.incomingLen <= 10)
const mid = results.filter((r) => r.incomingLen > 10 && r.incomingLen <= 30)
const long = results.filter((r) => r.incomingLen > 30)
for (const [name, set] of [['短消息 ≤10 字', short], ['中消息 11~30 字', mid], ['长消息 >30 字', long]]) {
  if (set.length === 0) continue
  console.log(
    `${name}：${set.length} 个样本｜对方均 ${avg(set.map((r) => r.incomingLen)).toFixed(0)} 字 → 回复均 ${avg(set.map((r) => r.replyLen)).toFixed(0)} 字` +
      `｜单行率 ${((set.filter((r) => r.lines === 1).length / set.length) * 100).toFixed(0)}%` +
      `｜最多 ${Math.max(...set.map((r) => r.lines))} 条`,
  )
}

const multi = results.filter((r) => r.lines > 1)
console.log(`\n整体：单行率 ${((results.filter((r) => r.lines === 1).length / results.length) * 100).toFixed(0)}%｜多行样本 ${multi.length} 个｜最多 ${Math.max(...results.map((r) => r.lines))} 条（上限 ${config.replyMaxLines}）`)

// 长度是否真的跟着对方走：按对方长度分桶看平均回复长度是否单调
const buckets = [[0, 5], [6, 15], [16, 40], [41, 999]]
console.log('\n长度跟随性（对方长度 → 平均回复长度）：')
for (const [lo, hi] of buckets) {
  const set = results.filter((r) => r.incomingLen >= lo && r.incomingLen <= hi)
  if (set.length === 0) continue
  const a = avg(set.map((r) => r.incomingLen))
  const b = avg(set.map((r) => r.replyLen))
  console.log(`  ${String(lo).padStart(3)}~${hi === 999 ? '∞' : String(hi).padStart(3)} 字：${set.length} 样本｜对方均 ${a.toFixed(0)} → 回复均 ${b.toFixed(0)} 字`)
}

// 违规检查
console.log('\n=== 违规检查 ===')
const leaked = results.filter((r) => /形态要求|系统自动生成|预算|字以内/.test(r.raw))
const bracket = results.filter((r) => /\[(回应|回复|系统|本次)/.test(r.raw))
const brokenFace = results.filter((r) => r.lines > 0 && /\[表情[^\]]*$/.test(r.raw))
const numbered = results.filter((r) => /^\s*(\d+[.、)]|[-*•])\s/m.test(r.raw))
console.log(`  提示词泄漏到回复里：${leaked.length === 0 ? '✅ 无' : `❌ ${leaked.length} 个`}`)
console.log(`  方括号前缀标记：${bracket.length === 0 ? '✅ 无' : `❌ ${bracket.length} 个`}`)
console.log(`  残缺表情标记：${brokenFace.length === 0 ? '✅ 无' : `❌ ${brokenFace.length} 个`}`)
console.log(`  列表/编号格式：${numbered.length === 0 ? '✅ 无' : `⚠️ ${numbered.length} 个（会被 shapeReply 清掉）`}`)
const overLimit = results.filter((r) => r.lines > config.replyMaxLines)
console.log(`  超过 ${config.replyMaxLines} 行：${overLimit.length === 0 ? '✅ 无' : `❌ ${overLimit.length} 个`}`)
const overChars = results.filter((r) => r.replyLen > config.replyMaxLines * config.replyLineMaxChars)
console.log(`  总字数超上限：${overChars.length === 0 ? '✅ 无' : `❌ ${overChars.length} 个`}`)
