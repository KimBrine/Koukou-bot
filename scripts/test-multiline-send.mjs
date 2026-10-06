/**
 * 端到端集成测试：不联网、不发真实消息，用假 OneBot 客户端跑真实的 handleMessage，
 * 验证「模型输出多行 → 真的分多条消息发出」这条链路。
 *   node scripts/test-multiline-send.mjs
 */
import { createBot } from '../src/bot.js'
import { createRateLimiter } from '../src/humanize.js'

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

const BASE_CONFIG = {
  botName: '小口口子',
  whitelistGroups: new Set([200000001]),
  proactiveRate: 0,
  proactiveCooldownMs: 0,
  quietHours: '',
  contextRememberAll: true,
  replyLengthMatch: true,
  replyMaxLines: 3,
  replyLineMaxChars: 40,
  lineGapMinMs: 0,
  lineGapMaxMs: 0,
  humanDelayMinMs: 0,
  humanDelayMaxMs: 0,
  emojiKeepRate: 0,
  visionMaxImages: 4,
  visionMaxImageBytes: 6 * 1024 * 1024,
  visionImageTimeoutMs: 20000,
  pokeEnabled: false,
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

/** 造一个假的机器人环境，返回 { bot, sent, memory } */
function makeBot({ llmReply, config = {}, rateLimiter = null, rand = Math.random, dailySummary = null }) {
  const sent = []
  const store = new Map()
  const memory = {
    get(key) {
      if (!store.has(key)) store.set(key, [])
      return store.get(key)
    },
    push(key, role, content) {
      this.get(key).push({ role, content })
    },
  }
  const onebot = {
    selfId: '200000014',
    async sendGroup(groupId, text) {
      sent.push({ type: 'group', target: groupId, text })
    },
    async sendPrivate(userId, text) {
      sent.push({ type: 'private', target: userId, text })
    },
    async getMsg() {
      return null
    },
    async getGroupMemberInfo() {
      return null
    },
  }
  const bot = createBot({
    config: { ...BASE_CONFIG, ...config },
    logger: silentLogger,
    onebot,
    llm: { chat: async () => llmReply, chatRaw: async () => ({ content: llmReply, toolCalls: null }) },
    visionLLM: null,
    memory,
    buildSystemPrompt: () => '你是群里的一员。',
    dailySummary,
    webSearch: null,
    pokeReplier: null,
    targetWatch: null,
    replyLog: null,
    rateLimiter,
    rand,
  })
  return { bot, sent, memory }
}

/** 固定随机源：0.5 落在"三行"区间（内容超过两行容量时），让分条行为可预测 */
const RAND_THREE_LINES = () => 0.5
/** 超过两行容量（>80 字）的对方消息，配合 RAND_THREE_LINES 必得 3 行计划 */
const LONG_INCOMING =
  '我刚刚打完一把，队友全程挂机，我拿辅助打了四十分钟最后还是输了，真的服了这帮人，你说这游戏还能玩吗，我上次也遇到过这种队友，全程在泉水挂机，举报了也没用，这游戏真的越来越难玩了'

/** 造一条"群里 @ 机器人"的消息事件 */
function atMessage(text, userId = 123456) {
  return {
    message_type: 'group',
    group_id: 200000001,
    user_id: userId,
    message_id: String(Math.floor(Math.random() * 1e9)),
    message: `[CQ:at,qq=200000014] ${text}`,
    sender: { nickname: '测试群友', card: '' },
  }
}

console.log('\n=== 1. 长消息 + 模型给 3 行：分条不变量（行数是随机的，故跑多轮看契约） ===')
{
  const threeLines = '第一句话在这里\n第二句话在这里\n第三句话在这里'
  const longIncoming = '我刚刚打完一把，队友全程挂机，我拿辅助打了四十分钟最后还是输了，真的服了这帮人，你说这游戏还能玩吗'
  const counts = []
  let allSingleLine = true
  let allInLimit = true
  let contentKept = true
  let overMax = 0
  for (let i = 0; i < 30; i++) {
    const { bot, sent } = makeBot({ llmReply: threeLines })
    await bot.handleMessage(atMessage(longIncoming))
    counts.push(sent.length)
    if (sent.some((s) => s.text.includes('\n'))) allSingleLine = false
    if (sent.some((s) => s.text.length > 40)) allInLimit = false
    if (sent.length > 3) overMax++
    // 没有触发裁剪时，所有行拼起来应当等于原文去掉换行（内容不丢）
    if (sent.map((s) => s.text).join('') !== threeLines.replace(/\n/g, '')) contentKept = false
  }
  const uniq = [...new Set(counts)].sort()
  ok('每条消息只有一行（换行真的是分开发送的）', allSingleLine, `→ 30 轮观察`)
  ok('每条都不超过单行上限 40 字', allInLimit)
  ok('分条数不超过 REPLY_MAX_LINES', overMax === 0, `→ 出现过的条数：${uniq.join('/')}`)
  ok('内容不丢失（各行拼接等于原文）', contentKept)
  ok('确实出现了多条分发现象', uniq.some((n) => n >= 2), `→ 出现过的条数：${uniq.join('/')}`)
  ok('也出现过 3 条（长内容会分满）', uniq.includes(3), `→ 出现过的条数：${uniq.join('/')}`)
}

console.log('\n=== 1b. 同一场景固定随机源 → 稳定分 3 条 ===')
{
  const threeLines = '第一句话在这里\n第二句话在这里\n第三句话在这里'
  const { bot, sent } = makeBot({ llmReply: threeLines, rand: RAND_THREE_LINES })
  await bot.handleMessage(atMessage(LONG_INCOMING))
  ok('确定性地发成 3 条', sent.length === 3, `→ ${JSON.stringify(sent.map((s) => s.text))}`)
  ok('三条内容与模型输出逐条一致', sent.map((s) => s.text).join('|') === threeLines.split('\n').join('|'))
  ok('每条都不超过单行上限', sent.every((s) => s.text.length <= 40), `→ 长度 ${sent.map((s) => s.text.length).join('/')}`)
  ok('发到正确的群', sent.every((s) => s.target === 200000001))
}

console.log('\n=== 2. 短消息 → 单行 → 只发 1 条 ===')
{
  const { bot, sent } = makeBot({ llmReply: '在的呀' })
  await bot.handleMessage(atMessage('在吗'))
  ok('只发 1 条', sent.length === 1, `→ ${JSON.stringify(sent.map((s) => s.text))}`)
}

console.log('\n=== 3. 模型把长内容写成一行 → 自动拆条发出 ===')
{
  const long =
    '四十分钟辅助局真的太折磨人了，你队友全程挂机也是够离谱的，换我早就投了，真的服气，下次记得叫我一起玩'
  const longIncoming = '我刚刚打完一把，队友全程挂机，我拿辅助打了四十分钟最后还是输了，真的服了这帮人，你说这游戏还能玩吗'
  let splitRuns = 0
  let badStart = 0
  let allSingle = true
  let minKeep = 1
  for (let i = 0; i < 30; i++) {
    const { bot, sent } = makeBot({ llmReply: long })
    await bot.handleMessage(atMessage(longIncoming))
    if (sent.length >= 2) splitRuns++
    if (sent[0].text.slice(0, 6) !== long.slice(0, 6)) badStart++
    if (sent.some((s) => s.text.includes('\n'))) allSingle = false
    minKeep = Math.min(minKeep, sent.map((s) => s.text).join('').length / long.length)
  }
  ok('模型只给一行时也会拆条发出', splitRuns > 0, `→ 30 轮里 ${splitRuns} 轮拆了条`)
  ok('拆条后开头内容保持不变', badStart === 0)
  ok('拆条不会把内容砍掉大半', minKeep > 0.6, `→ 最少保留 ${(minKeep * 100).toFixed(0)}%`)
  ok('拆出来的每条都是单行', allSingle)
}

console.log('\n=== 4. 多行里混入 QQ 表情 → 行结构不被压平、表情转成真实 CQ 码 ===')
{
  // emojiKeepRate=0 → 必定走"去装饰"分支，正是这个分支会把纯表情行删空、进而把两行粘成一行
  const { bot, sent } = makeBot({
    llmReply: '笑死我了\n[表情:doge]\n你也太逗了',
    config: { emojiKeepRate: 0 },
    rand: RAND_THREE_LINES,
  })
  await bot.handleMessage(atMessage(LONG_INCOMING))
  ok('仍然是 3 条（没被压成一条）', sent.length === 3, `→ ${JSON.stringify(sent.map((s) => s.text))}`)
  ok('纯表情行被保留', /\[CQ:face,id=\d+\]/.test(sent[1]?.text ?? ''), `→ ${sent[1]?.text}`)
  ok('没有出现"两行粘一起"的空格粘连', !sent.some((s) => s.text.includes('笑死我了 ') || s.text.includes(' 你也太逗了')))
  ok('没有残缺表情标记', sent.every((s) => !/\[表情[^\]]*$/.test(s.text)))
}

console.log('\n=== 4b. 保留装饰时两行原样发出 ===')
{
  const { bot, sent } = makeBot({ llmReply: '笑死我了🍥\n你也太逗了', config: { emojiKeepRate: 1 }, rand: RAND_THREE_LINES })
  await bot.handleMessage(atMessage(LONG_INCOMING))
  ok('两行分别发出且装饰保留', sent.length === 2 && sent.some((s) => s.text.includes('🍥')), `→ ${JSON.stringify(sent.map((s) => s.text))}`)
}

console.log('\n=== 5. 限流：额度只剩 1 条时，后续行不再发送 ===')
{
  let overSend = 0
  for (let i = 0; i < 12; i++) {
    const rateLimiter = createRateLimiter({ perHour: 1, minGapMs: 0 })
    const { bot, sent } = makeBot({
      llmReply: '第一句话在这里\n第二句话在这里\n第三句话在这里',
      rateLimiter,
    })
    await bot.handleMessage(
      atMessage('我刚刚打完一把，队友全程挂机，我拿辅助打了四十分钟最后还是输了，真的服了这帮人，你说这游戏还能玩吗'),
    )
    if (sent.length > 1) overSend++
  }
  ok('额度用完就不再发后续行', overSend === 0, `→ 12 轮中越界 ${overSend} 次`)
}

console.log('\n=== 6. 记忆里存的是完整多行（模型下次能看到自己说过什么） ===')
{
  const threeLines = '第一句话在这里\n第二句话在这里\n第三句话在这里'
  const { bot, sent, memory } = makeBot({ llmReply: threeLines })
  await bot.handleMessage(
    atMessage('我刚刚打完一把，队友全程挂机，我拿辅助打了四十分钟最后还是输了，真的服了这帮人，你说这游戏还能玩吗'),
  )
  const assistant = memory.get('g200000001').filter((h) => h.role === 'assistant')
  ok('记了一条 assistant 消息', assistant.length === 1)
  ok(
    '记忆内容与实发内容一致（含换行结构）',
    assistant[0].content === sent.map((s) => s.text).join('\n'),
    `→ ${JSON.stringify(assistant[0].content)}`,
  )
  ok('记忆内容不含任何内部前缀标记', !/\[(回应|回复|系统)/.test(assistant[0].content))
}

console.log('\n=== 7. 私聊路径同样分条 ===')
{
  const { bot, sent } = makeBot({
    llmReply: '第一句话在这里\n第二句话在这里\n第三句话在这里',
    rand: RAND_THREE_LINES,
  })
  await bot.handleMessage({
    message_type: 'private',
    user_id: 999,
    message_id: 'p1',
    message: LONG_INCOMING,
    sender: { nickname: '测试' },
  })
  ok('私聊也发成 3 条', sent.length === 3 && sent.every((s) => s.type === 'private'), `→ ${sent.length} 条`)
}

console.log(`\n=== 8. 手动群总结指令：回执要说人话 ===`)
{
  const mkSummary = ({ running = false, count = 0, groups = [200000001] } = {}) => {
    const calls = []
    return {
      calls,
      summaryGroups: () => groups,
      isRunning: () => running,
      countCaptured: () => count,
      capture: () => {},
      trigger: (targets, opts) => calls.push({ targets, opts }),
    }
  }

  // 正常情况：回执要立刻回、要给出预估时间
  //
  // ⚠️ 这里**故意不再断言回执里带条数**。老行为是按 countCaptured（只数落盘的实时捕获）
  //    报一个数字，而报告主体其实来自 NapCat 历史回填 —— 2026-09-27 用户就撞上了：
  //    机器人刚重启，捕获只有 1 条，回执说"正在翻 1 条记录"，实际报告覆盖了 218 条。
  //    与其报一个不可信的数字，不如不报。见 src/bot.js 里的注释。
  {
    const summary = mkSummary({ count: 420 })
    const { bot, sent } = makeBot({ llmReply: '好呀', dailySummary: summary })
    await bot.handleMessage(atMessage('/群总结 7'))
    const ack = sent[0]?.text ?? ''
    ok('识别指令并立刻回执', /收到/.test(ack), `→ ${ack}`)
    ok('回执里不再报不可信的条数', !/\d+\s*条/.test(ack), `→ ${ack}`)
    ok('回执里说明了时间范围', /最近 7 天/.test(ack), `→ ${ack}`)
    ok('回执里给出预估时间', /大概/.test(ack), `→ ${ack}`)
    ok('触发了对应天数的生成', summary.calls.length === 1 && summary.calls[0].opts.days === 7, `→ ${JSON.stringify(summary.calls[0]?.opts)}`)
    ok('目标群就是当前群', summary.calls[0]?.targets?.[0] === 200000001)
  }

  // 天数/群数多 → 预估时间变长（不再依赖条数）
  {
    const summary = mkSummary({ count: 1200 })
    const { bot, sent } = makeBot({ llmReply: '好呀', dailySummary: summary })
    await bot.handleMessage(atMessage('/群总结 14'))
    ok('多天总结给出较长的预估时间', /3~6 分钟/.test(sent[0]?.text ?? ''), `→ ${sent[0]?.text}`)
  }

  // 上一份还在跑 → 明确告知，而不是静默丢弃
  {
    const summary = mkSummary({ running: true, count: 300 })
    const { bot, sent } = makeBot({ llmReply: '好呀', dailySummary: summary })
    await bot.handleMessage(atMessage('/群总结'))
    ok('正在生成时会明确告知等待', /还在写/.test(sent[0]?.text ?? ''), `→ ${sent[0]?.text}`)
    ok('不会重复触发一次生成', summary.calls.length === 0)
  }

  // 全角斜杠 / 结尾标点也要认
  {
    const summary = mkSummary({ count: 50 })
    const { bot, sent } = makeBot({ llmReply: '好呀', dailySummary: summary })
    await bot.handleMessage(atMessage('／群总结 3。'))
    ok('全角斜杠 + 结尾句号也能识别', summary.calls.length === 1 && summary.calls[0].opts.days === 3, `→ ${sent[0]?.text}`)
  }

  // 普通聊天不能被当成指令
  {
    const summary = mkSummary({ count: 50 })
    const { bot } = makeBot({ llmReply: '好呀', dailySummary: summary })
    await bot.handleMessage(atMessage('总结里记得把我写帅点🍥'))
    ok('普通聊天不触发总结', summary.calls.length === 0)
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
