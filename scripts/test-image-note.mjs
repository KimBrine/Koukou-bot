/**
 * 复现"图没加载出来"误报：
 *   回归场景：纯表情消息不应被历史图片占位符误判为图片加载失败。
 *   因为历史里上一条是 [图片]，旧提示词让模型"看不到图就说图没加载出来"，它就自己套上去了。
 *
 * 修法：这件事由代码判断并明确告知（imageNote），提示词里不再给模型自主判断的授权。
 *
 *   node scripts/test-image-note.mjs [每种情况轮数]
 *
 * 只调用模型，不发消息。
 */
import { loadConfig } from '../src/config.js'
import { DeepSeekClient } from '../src/deepseek.js'
import { buildChatAppendix } from '../src/chatAppendix.js'
import { measureText, planReply, shapeReply, shapeHint, decorationHint } from '../src/replyShape.js'

const N = Math.max(2, Number(process.argv[2]) || 4)
const config = loadConfig()
const logger = { info: () => {}, warn: (m) => console.log(`  [warn] ${m}`), error: () => {}, debug: () => {} }
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

// 虚构上下文：历史图片占位符与当前消息类型的回归场景
const HISTORY = [
  { role: 'user', content: '【示例群友乙（昵称含表情）🐳🐳🐳】今天开始放假' },
  { role: 'user', content: '【示例群友丙👑👑👑【别名】】[@200000008] 这条消息很有意思' },
  { role: 'user', content: '【示例群友丙👑👑👑【别名】】还剩几分钟' },
  { role: 'assistant', content: '假期快到啦，记得好好休息🍥(=^▽^=)' },
  { role: 'user', content: '【示例群友丙👑👑👑【别名】】[图片]' }, // ← 罪魁祸首：历史里的图片占位
]

const IMAGE_FAIL_NOTE =
  '\n\n【图片状态】这条消息带了图，但内容没取到。你可以自然地说一句图没加载出来，一句就够，别多解释。'
const IMAGE_OK_NOTE =
  '\n\n【图片状态】这条消息里的图你已经看到了，正常接梗就行，**不要说图没加载出来**。'

const CASES = [
  {
    name: '纯表情消息（历史里有 [图片]）',
    content: '【示例群友丙👑👑👑【别名】】[表情:知识增加]',
    note: '',
    forbid: /没加载|加载不出|看不到图|图呢|图挂了/,
  },
  {
    name: '纯文字消息（历史里有 [图片]）',
    content: '【示例群友乙（昵称含表情）🐳🐳🐳】一会儿去吃饭不',
    note: '',
    forbid: /没加载|加载不出|看不到图/,
  },
  {
    name: '带图但没取到内容（代码明确告知）',
    content: '【示例群友丙👑👑👑【别名】】[图片]',
    note: IMAGE_FAIL_NOTE,
    forbid: null, // 这种情况本来就该提一句
    expect: /没加载|加载不出|看不到|图.*没|没.*图/,
  },
  {
    name: '带图且能看到（代码明确告知）',
    content: '【示例群友丙👑👑👑【别名】】[图片]',
    note: IMAGE_OK_NOTE + '\n\n（你看这张图：一只橘猫趴在键盘上睡觉）',
    forbid: /没加载|加载不出|看不到图/,
  },
]

let bad = 0
let total = 0
for (const c of CASES) {
  console.log(`\n── ${c.name} ──`)
  for (let i = 0; i < N; i++) {
    const plan = planReply({ incomingLen: measureText(c.content) || 6, maxLines: config.replyMaxLines, lineMaxChars: config.replyLineMaxChars })
    const allow = Math.random() < config.emojiKeepRate
    const time = new Date().toLocaleString('zh-CN', { hour12: false })
    const systemPrompt = `${config.persona}${buildChatAppendix({ time })}${c.note}${shapeHint(plan)}${decorationHint(allow, 'fishcake')}`
    let raw
    try {
      raw = await llm.chat(systemPrompt, [...HISTORY, { role: 'user', content: c.content }])
    } catch (err) {
      console.log(`  ❌ 调用失败：${err.message}`)
      continue
    }
    const text = shapeReply(raw, plan).join(' ')
    total++
    let verdict = '·'
    if (c.forbid && c.forbid.test(text)) {
      verdict = '❌ 违规（不该提图却提了）'
      bad++
    } else if (c.expect && !c.expect.test(text)) {
      verdict = '⚠️ 该提没提'
    } else {
      verdict = '✅'
    }
    console.log(`  ${verdict} 「${text}」`)
  }
}

console.log(`\n=== 结果：${total} 个样本，误报 ${bad} 个 ===`)
process.exit(bad === 0 ? 0 : 1)
