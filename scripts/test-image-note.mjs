/**
 * 复现"图没加载出来"误报：
 *   2026-09-21 15:58 春雨社，机器人对着一条纯表情消息回了「图没加载出来诶」——
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

// 直接取自当时的真实上下文（春雨社）
const HISTORY = [
  { role: 'user', content: '【咲璃绫（浓稠的鲸）🐳🐳🐳】现在开始没课' },
  { role: 'user', content: '【飏趫烃（绝对的皇）👑👑👑【水母大王】】[@2472260176] 绷不住了' },
  { role: 'user', content: '【飏趫烃（绝对的皇）👑👑👑【水母大王】】还有三分钟' },
  { role: 'assistant', content: '还有三分钟就解放啦，羡慕去打瓦的宝宝🍥(=^▽^=)' },
  { role: 'user', content: '【飏趫烃（绝对的皇）👑👑👑【水母大王】】[图片]' }, // ← 罪魁祸首：历史里的图片占位
]

const IMAGE_FAIL_NOTE =
  '\n\n【图片状态】这条消息带了图，但内容没取到。你可以自然地说一句图没加载出来，一句就够，别多解释。'
const IMAGE_OK_NOTE =
  '\n\n【图片状态】这条消息里的图你已经看到了，正常接梗就行，**不要说图没加载出来**。'

const CASES = [
  {
    name: '纯表情消息（历史里有 [图片]）',
    content: '【飏趫烃（绝对的皇）👑👑👑【水母大王】】[表情:知识增加]',
    note: '',
    forbid: /没加载|加载不出|看不到图|图呢|图挂了/,
  },
  {
    name: '纯文字消息（历史里有 [图片]）',
    content: '【咲璃绫（浓稠的鲸）🐳🐳🐳】一会儿去吃饭不',
    note: '',
    forbid: /没加载|加载不出|看不到图/,
  },
  {
    name: '带图但没取到内容（代码明确告知）',
    content: '【飏趫烃（绝对的皇）👑👑👑【水母大王】】[图片]',
    note: IMAGE_FAIL_NOTE,
    forbid: null, // 这种情况本来就该提一句
    expect: /没加载|加载不出|看不到|图.*没|没.*图/,
  },
  {
    name: '带图且能看到（代码明确告知）',
    content: '【飏趫烃（绝对的皇）👑👑👑【水母大王】】[图片]',
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
