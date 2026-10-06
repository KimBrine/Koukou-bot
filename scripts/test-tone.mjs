/**
 * 语气实测：按生产链路跑一批真实回复，量"最终发出去的那条"的装饰频率与可爱度。
 *
 *   node scripts/test-tone.mjs [轮数]
 *
 * 链路与 bot.js 完全一致：persona + chatAppendix + shapeHint(plan) + decorationHint(allow)
 *   → 模型生成 → shapeReply 分条 → limitDecorationLines(allow ? 1 : 0)
 * 只调用模型，不发送任何 QQ 消息。
 */
import { loadConfig } from '../src/config.js'
import { DeepSeekClient } from '../src/deepseek.js'
import { buildChatAppendix } from '../src/chatAppendix.js'
import { limitDecorationLines, hasDecoration, stripDecoration } from '../src/humanize.js'
import { measureText, planReply, shapeReply, shapeHint, decorationHint, ensureDecoration, pickDecorationKind } from '../src/replyShape.js'

const N = Math.max(4, Number(process.argv[2]) || 24)
const config = loadConfig()
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
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

// 群里常见的短消息（最容易把回复逼成"干巴巴一句"的场景）
const INCOMING = [
  '在吗',
  '哈哈哈哈哈哈哈',
  '你们在干嘛呀',
  '今天好累啊',
  '这个也太好笑了吧',
  '我刚吃完饭',
  '有人吗',
  '？',
  '啊啊啊啊我不想写作业',
  '你们觉得这个怎么样',
  '好无聊啊',
  '我又饿了',
  '谁在',
  '刚刚那个图笑死我了',
  '我睡了',
  '你怎么看',
  '别理我',
  '救命啊',
  '今天天气真好',
  '我买了新键盘，手感特别好，就是有点吵',
  '刚才那局打得我血压都上来了，队友全程在挂机，你说这游戏还能不能玩了',
  '诶嘿',
]

// 模拟群聊上下文（有前文才不会显得突兀）
const HISTORY = [
  { role: 'user', content: '【大肥鱼】谁在群里偷偷说我坏话' },
  { role: 'assistant', content: '我可没有，我一直在老实记账' },
  { role: 'user', content: '【ανοη】账本上写的都是真的吧' },
  { role: 'assistant', content: '那当然，都是他自己认领的' },
]

const toneWords = /(呀|啦|嘛|捏|哦|诶|嘿|呜|嗯哼|人家|宝宝|嘿嘿|哈哈|awa|QAQ)/
const results = []

console.log(`=== 语气实测：${N} 轮（模型 ${config.deepseekModel}，装饰保留率 ${config.emojiKeepRate}）===\n`)

for (let i = 0; i < N; i++) {
  const text = INCOMING[i % INCOMING.length]
  const incomingLen = measureText(text)
  const plan = planReply({
    incomingLen,
    maxLines: config.replyMaxLines,
    lineMaxChars: config.replyLineMaxChars,
    matchEnabled: config.replyLengthMatch,
  })
  const allow = Math.random() < config.emojiKeepRate
  const decoKind = allow ? pickDecorationKind() : ''
  const time = new Date().toLocaleString('zh-CN', { hour12: false })
  const systemPrompt = `${config.persona}${buildChatAppendix({ time })}${shapeHint(plan)}${decorationHint(allow, decoKind)}`

  let raw
  try {
    raw = await llm.chat(systemPrompt, [...HISTORY, { role: 'user', content: `【群友】${text}` }])
  } catch (err) {
    console.log(`  ❌ 第 ${i + 1} 轮失败：${err.message}`)
    continue
  }

  let lines = shapeReply(raw, plan)
  if (lines.length === 0) lines = ['嗯嗯']
  // 与 bot.js 完全一致：决定卖萌就保证装饰真的带上（模型自己带了就不插手）
  if (allow) lines = ensureDecoration(lines, raw, { kind: decoKind })
  const finalLines = limitDecorationLines(lines, allow ? 1 : 0)
  const finalText = finalLines.join('\n')
  const modelDeco = hasDecoration(raw)
  const finalDeco = hasDecoration(finalText)

  results.push({ incoming: text, allow, modelDeco, finalDeco, finalText, len: finalText.length })
  console.log(
    `[${String(i + 1).padStart(2)}] 对方「${text}」(${incomingLen}字) → ${finalText.length}字${finalLines.length > 1 ? ` ${finalLines.length}条` : ''}` +
      `　装饰:${allow ? '允许' : '禁止'}→模型${modelDeco ? '带了' : '没带'}/最终${finalDeco ? '有' : '无'}`,
  )
  console.log(`     ${finalLines.map((l) => `「${l}」`).join(' + ')}`)
}

// ── 统计 ─────────────────────────────────────────────────────────────
const n = results.length
const allowed = results.filter((r) => r.allow)
const banned = results.filter((r) => !r.allow)
const finalDecoRate = (results.filter((r) => r.finalDeco).length / n) * 100
const complyAllowed = allowed.length ? (allowed.filter((r) => r.finalDeco).length / allowed.length) * 100 : 0
const complyBanned = banned.length ? (banned.filter((r) => r.finalDeco).length / banned.length) * 100 : 0
const fishcake = results.filter((r) => /🍥/u.test(r.finalText)).length
const kao = results.filter((r) => /[（(][^（）()]{0,20}[=^▽ωﾉ≧≦ΣД゜∀´ˊˋ・﹏◕‿⌒＞＜＾°◡ᴗಥஇ｡•︿⊙△▼][^（）()]{0,20}[）)]/u.test(r.finalText)).length

console.log(`\n=== 统计（${n} 轮）===`)
console.log(`  代码允许装饰的轮次: ${allowed.length}/${n} = ${((allowed.length / n) * 100).toFixed(0)}%（目标 ${(config.emojiKeepRate * 100).toFixed(0)}%）`)
console.log(`  ★ 最终带装饰的回复: ${results.filter((r) => r.finalDeco).length}/${n} = ${finalDecoRate.toFixed(1)}%（目标约 ${(config.emojiKeepRate * 100).toFixed(0)}%）`)
console.log(`  ★ 带 🍥 的回复:      ${fishcake}/${n} = ${((fishcake / n) * 100).toFixed(1)}%（人设里的最爱，应该跟着装饰率走）`)
console.log(`  带颜文字的回复:      ${kao}/${n} = ${((kao / n) * 100).toFixed(1)}%`)
console.log(`  允许时模型确实带了: ${complyAllowed.toFixed(0)}%（越高说明"允许"这条指令被听进去了）`)
console.log(`  禁止时仍带装饰:     ${complyBanned.toFixed(0)}%（应为 0，代码会清掉）`)
console.log(`  平均长度: ${(results.reduce((a, b) => a + b.len, 0) / n).toFixed(1)} 字`)
console.log(`  带语气词/口癖的回复: ${results.filter((r) => toneWords.test(r.finalText)).length}/${n} = ${((results.filter((r) => toneWords.test(r.finalText)).length / n) * 100).toFixed(0)}%`)
console.log(`  纯文字且完全无口癖（最"干"的）: ${results.filter((r) => !toneWords.test(r.finalText) && !r.finalDeco).length}/${n}`)

// 被剥掉装饰的例子（说明"事后清洗"对语气的影响）
const stripped = results.filter((r) => !r.allow && r.modelDeco)
if (stripped.length) {
  console.log(`\n--- 被清成纯文字的例子（${stripped.length} 条）---`)
  for (const r of stripped.slice(0, 4)) console.log(`  「${r.finalText}」`)
}
