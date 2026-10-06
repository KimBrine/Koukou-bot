import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { MemoryStore } from './memory.js'
import { DeepSeekClient } from './deepseek.js'
import { OneBotClient } from './onebot.js'
import { buildSystemPrompt } from './persona.js'
import { createBot } from './bot.js'
import { createDailySummary, buildSummaryPrompt } from './dailySummary.js'
import { createWebSearch } from './search.js'
import { loadPokeReplies, createPokeReplier } from './pokeReplies.js'
import { createLongMemory } from './longMemory.js'
import { createTargetWatch } from './targetWatch.js'
import { createChatSettings } from './chatSettings.js'
import { createDailyPing } from './dailyPing.js'
import { createAdminServer } from './admin/server.js'
import { createRateLimiter } from './humanize.js'
import { buildChatAppendix } from './chatAppendix.js'

const config = loadConfig()
const logger = createLogger(config.logLevel, config.logFile)

// 隐藏窗口启动时 stdout/stderr 会落到 logs/console.log；成功启动后把它清空，
// 这样里面留下的永远只是"最近一次启动阶段的输出"，启动崩溃时一眼就能看到报错
try {
  const consoleLog = path.join(config.logDir, 'console.log')
  if (existsSync(consoleLog) && statSync(consoleLog).size > 256 * 1024) writeFileSync(consoleLog, '')
} catch {
  /* ignore */
}

if (!config.deepseekApiKey) {
  logger.error('未配置 DeepSeek API Key。')
  logger.error('请编辑项目根目录的 .env 文件，填入：DEEPSEEK_API_KEY=sk-...')
  logger.error('Key 获取地址：https://platform.deepseek.com/api_keys')
  process.exit(1)
}

// ===== 单实例锁：防止重复启动导致多实例抢答（重复回复的根源）=====
//
// ⚠️ 锁里必须带"本次开机时间"，不能只记 PID。
//    2026-09-27 的教训：电脑重启后，重启前的实例没了、锁文件留在磁盘上，
//    而 Windows 把那个 PID 号复用给了别的进程 → `process.kill(pid, 0)` 检测"进程存在"
//    → 机器人以为已有实例在跑，自己退出，**白停了 10 小时没人发现**。
//    带上开机时间后，跨开机的锁一律按陈旧处理，直接清掉。
const bootAt = Date.now() - Math.round(os.uptime() * 1000)
const lockContent = () =>
  JSON.stringify({ pid: process.pid, bootAt, profile: config.botProfile, startedAt: new Date().toISOString() })

const lockFile = path.join(config.dataDir, 'bot.lock')
if (existsSync(lockFile)) {
  const raw = readFileSync(lockFile, 'utf8').trim()
  let info = {}
  try {
    info = JSON.parse(raw)
  } catch {
    info = { pid: Number(raw) } // 兼容旧的纯数字格式
  }
  const oldPid = Number(info?.pid)
  const lockBoot = Number(info?.bootAt)
  const fromThisBoot = Number.isFinite(lockBoot) && Math.abs(lockBoot - bootAt) < 60000
  if (Number.isFinite(lockBoot) && !fromThisBoot) {
    logger.warn(`发现上一次开机残留的锁（PID ${oldPid}），按陈旧锁清理（PID 可能已被别的进程复用）`)
  } else if (Number.isFinite(oldPid) && oldPid > 0) {
    let alive = false
    try {
      process.kill(oldPid, 0)
      alive = true
    } catch {
      /* 进程不存在 */
    }
    if (alive) {
      const who = [info?.profile ? `实例 ${info.profile}` : '', info?.startedAt ? `启动于 ${info.startedAt}` : '']
        .filter(Boolean)
        .join('，')
      logger.error(
        `检测到已有机器人实例在运行（PID ${oldPid}${who ? '，' + who : ''}），本实例退出。` +
          `如需强制重启：先结束该进程，或删除 ${lockFile}`
      )
      process.exit(1)
    }
  }
  try {
    rmSync(lockFile)
  } catch {
    /* ignore */
  }
}
try {
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(lockFile, lockContent())
  process.on('exit', () => {
    try {
      // 锁内容是 JSON，要解析出 pid 再比，不能拿整串跟 pid 比（否则干净退出也不删锁）
      if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid) rmSync(lockFile)
    } catch {
      /* ignore */
    }
  })
} catch {
  /* 锁文件写入失败不影响运行 */
}

const memory = new MemoryStore({ file: config.memoryFile, limit: config.historyLimit, logger })
memory.load()

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

// 视觉模型：消息带图片/表情包时先把图读成文字描述，再交给对话模型写人设回复。
//
// 谁来读图由 VISION_PROVIDER 决定（实测 2026-09-24，同一张真实群图各跑 3 轮）：
//   deepseek  → deepseek-flash  平均 1.9s，描述准确简洁（约 150 token）
//   dashscope → qwen3.7-flash   平均 40.4s，描述同样准确但每张图写 2000+ token
//   差的 21 倍几乎全在输出长度上 —— 提示词里写了"120 字以内"，qwen 并不照做。
// 注意：deepseek-v4-pro **不能读图**（会回"无法查看图片"），别拿它当视觉模型。
let visionLLM = null
if (config.visionProvider === 'deepseek' ? config.deepseekApiKey : config.dashscopeApiKey) {
  const isDeepseek = config.visionProvider === 'deepseek'
  visionLLM = new DeepSeekClient({
    apiKey: isDeepseek ? config.deepseekApiKey : config.dashscopeApiKey,
    baseUrl: isDeepseek ? config.deepseekBaseUrl : config.dashscopeBaseUrl,
    model: isDeepseek ? config.visionModel || 'deepseek-flash' : config.dashscopeModel,
    temperature: config.temperature,
    // 识图回复硬性限长：真人看到表情包只会随口吐槽一两句，不需要长篇分析
    maxTokens: Math.min(config.maxTokens, 300),
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxConcurrency: config.maxConcurrency,
    logger,
    label: isDeepseek ? 'DeepSeek 视觉' : '通义千问VL',
  })
}

// 每日总结模型：独立客户端（token 预算大）；可切换提供方（DeepSeek / 通义千问）
let summaryLLM = llm
if (config.summaryModel) {
  const useQwen = config.summaryProvider === 'dashscope'
  summaryLLM = new DeepSeekClient({
    apiKey: useQwen ? config.dashscopeApiKey : config.deepseekApiKey,
    baseUrl: useQwen ? config.dashscopeBaseUrl : config.deepseekBaseUrl,
    model: config.summaryModel,
    temperature: 1.0,
    // 长文总结需要充足预算（推理也占额度），实测 8000 足够
    maxTokens: config.summaryMaxTokens,
    timeoutMs: Math.max(config.timeoutMs, 180000),
    maxRetries: config.maxRetries,
    maxConcurrency: 1,
    logger,
    label: useQwen ? '总结模型(通义千问)' : '总结模型(DeepSeek)',
  })
}

const wsUrl = config.onebotAccessToken
  ? `${config.onebotWsUrl}${config.onebotWsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(config.onebotAccessToken)}`
  : config.onebotWsUrl

const onebot = new OneBotClient({ url: wsUrl, logger, probeUserId: config.idCheckOperators?.[0] || config.dailyPingTarget })

// 长期记忆：把被近期窗口挤出去的旧消息压缩成持续累积的摘要（用便宜的总结模型）
const longMemory = createLongMemory({
  file: path.join(config.dataDir, 'long-memory.json'),
  logger,
  llm: { chat: (prompt, messages) => summaryLLM.chat(prompt, messages) },
  maxChars: config.longMemoryMaxChars,
  intervalMs: config.longMemoryIntervalMs,
})
memory.onEvict = (key, entries) => longMemory.addEvicted(key, entries)

// 联网搜索（百度千帆）：仅私聊与被@时可用，模型自行判断是否需要
const webSearch = createWebSearch({ apiKey: config.baiduApiKey, timeoutMs: 20000, logger })

// 总结提示词：先注入小口口子人设（口吻一致），再给出报告格式与统计要求
const summaryPromptFn = (opts) => {
  const personaPart = config.persona
    ? `${config.persona}\n\n（注意：现在是在写「群聊日常分析报告」，不是日常聊天——上面人设里"一两句话、别长篇大论、回复长度跟着对方走"等聊天规则不适用于报告场景，口吻和语气保持一致即可，篇幅与格式以下面的报告要求为准。）\n\n`
    : ''
  return `${personaPart}${buildSummaryPrompt(opts)}`
}

// 总结调用：失败直接抛出（由上层通知群里），不用聊天模型兜底（其 token 预算远不够写长文）
const summaryChat = async (prompt, messages, options) => summaryLLM.chat(prompt, messages, options)

const dailySummary = createDailySummary({ config, logger, onebot, llm: { chat: summaryChat }, buildSummaryPromptFn: summaryPromptFn })

const systemPrompt = config.persona
  ? (opts) => {
      const time = new Date().toLocaleString('zh-CN', { hour12: false })
      const longMem = config.longMemoryEnabled && opts?.chatKey ? longMemory.get(opts.chatKey) : ''
      const memPart = longMem ? `\n\n【你对这里更早之前的长期记忆】\n${longMem}\n（以上是压缩过的旧记忆，近期原话见下面的对话历史。）` : ''
      // "今日已办"：抽猪猪这类当天做过的事，群聊刷几屏就滚出记忆窗口了，
      // 单独记一份注入提示词，机器人当天就不会再说"我还没抽过"。
      // （dailyPing 在本文件稍后创建；这里是闭包，真正调用时它已经初始化好了）
      const doneToday = dailyPing?.todayNote?.(opts?.chatKey) ?? ''
      return `${config.persona}${memPart}${doneToday}${buildChatAppendix({ time })}`
    }
  : (opts) => buildSystemPrompt({ botName: config.botName, now: opts?.now ?? new Date() })

// 拍一拍回复语（poke-replies.txt，可自行增删）
const pokeReplier = createPokeReplier(loadPokeReplies(config.rootDir, logger))

// 盯人回复：定期检查目标群里指定用户是否发过言，有则 @ 他回一两句
const replyLog = new Map() // `${groupId}:${userId}` -> 上次回复时间戳
// 反检测限流：所有发送路径共用（每个会话每小时上限 + 最小间隔）
const rateLimiter = createRateLimiter({ perHour: config.rateLimitPerHour, minGapMs: config.rateLimitMinGapMs })
const targetWatch = createTargetWatch({ config, logger, onebot, llm, memory, buildSystemPrompt: systemPrompt, replyLog, rateLimiter })

// 定时指令：每天定点到指定群 @ 某个账号发固定内容（当前：每天 00:00 在春雨社 @幽幽子 发 /今日猪猪）
const dailyPing = createDailyPing({
  config,
  logger,
  onebot,
  rateLimiter,
  memory,
  stateFile: path.join(config.dataDir, 'daily-ping-state.json'),
})

// 每个会话（群/私聊）的独立设置：控制台里改，存 data/chat-settings.json，改完立刻生效
const chatSettings = createChatSettings({ file: path.join(config.dataDir, 'chat-settings.json'), logger })

// 运行期计数：控制台总览用（不落盘，重启归零）
const runtimeStats = {
  startedAt: Date.now(),
  received: new Map(),
  replies: new Map(),
  lastMessage: new Map(),
  totalReceived: 0,
  totalReplied: 0,
  totalSkipped: 0,
  noteMessage(key, ts) {
    this.received.set(key, (this.received.get(key) || 0) + 1)
    this.lastMessage.set(key, ts)
    this.totalReceived += 1
  },
  noteReply(key) {
    this.replies.set(key, (this.replies.get(key) || 0) + 1)
    this.totalReplied += 1
  },
  noteSkip() {
    this.totalSkipped += 1
  },
}

const bot = createBot({ config, logger, onebot, llm, visionLLM, memory, buildSystemPrompt: systemPrompt, dailySummary, dailyPing, webSearch, pokeReplier, targetWatch, replyLog, rateLimiter, chatSettings, runtimeStats })

// 本地控制台：机器人自己托管界面，用 Edge/Chrome 的 app 模式窗口打开就像一个桌面应用
let adminServer = null
if (config.adminEnabled) {
  adminServer = createAdminServer({
    config,
    logger,
    onebot,
    memory,
    chatSettings,
    dailySummary,
    targetWatch,
    longMemory,
    runtimeStats,
    dailyPing,
    bot,
    restartBot: () => {
      // 让一个独立进程在 1.2 秒后杀掉当前实例并用计划任务重新拉起（避免自己杀自己杀不干净）
      //
      // ⚠️ 必须按 profile 隔离：并行跑两个机器人（换号迁移期间就是这样）时，
      //    只匹配 src\index.js 会把**两个实例全杀掉**，而且只拉起一个任务，
      //    另一个账号就静默掉线了。启动脚本会给进程带上 --profile=<名字> 作为识别标记；
      //    main 额外兼容历史上没带标记启动的进程。
      const profile = String(config.botProfile || 'main')
      logger.info(`[重启] profile=${profile} → 重启计划任务 ${config.botTaskName}`)
      try {
        const restartOutput = openSync(path.join(config.logDir, 'restart-spawn.log'), 'a')
        const child = spawn(process.execPath, [
          path.join(config.rootDir, 'bot-restart-worker.mjs'),
          String(process.pid), String(config.botTaskName || 'DeepSeekQQBot'), config.logDir,
        ], { detached: true, stdio: ['ignore', restartOutput, restartOutput], windowsHide: true })
        closeSync(restartOutput)
        child.on('spawn', () => logger.info(`[重启] 辅助进程 PID ${child.pid} 已启动`))
        child.on('error', (err) => logger.warn(`自动重启失败：${err.message}`))
        child.on('exit', (code, signal) => logger.warn(`[重启] 辅助进程结束：code=${code} signal=${signal}`))
      } catch (err) {
        logger.warn(`自动重启失败，请手动重启：${err.message}`)
      }
    },
  })
  adminServer.start(config.adminPort)
}

onebot.on('message', (evt) => {
  bot.handleMessage(evt).catch((err) => logger.error(`处理消息异常：${err?.stack || err}`))
})
onebot.on('notice', (evt) => {
  bot.handleNotice(evt).catch((err) => logger.error(`处理通知事件异常：${err?.stack || err}`))
})
onebot.on('ready', ({ selfId, nickname }) => {
  logger.info(`机器人就绪：${nickname}（${selfId}），开始监听消息…`)
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('正在关闭，保存记忆…')
  memory.flush()
  bot.flush()
  dailySummary.stop()
  onebot.stop()
  setTimeout(() => process.exit(0), 300).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.on('unhandledRejection', (err) => logger.error(`未处理的 Promise 拒绝：${err?.stack || err}`))
process.on('uncaughtException', (err) => logger.error(`未捕获异常：${err?.stack || err}`))

logger.info('===== DeepSeek × QQ 机器人启动 =====')
logger.info(`模型：${config.deepseekModel}`)
logger.info(
  visionLLM
    ? `视觉模型已启用：${config.visionProvider === 'deepseek' ? config.visionModel || 'deepseek-flash' : config.dashscopeModel} @ ${
        config.visionProvider === 'deepseek' ? config.deepseekBaseUrl : config.dashscopeBaseUrl
      }（provider=${config.visionProvider}，消息带图片时先把图读成描述再交给人设模型）`
    : '视觉模型未启用（缺视觉的 API Key，图片将只显示为占位符）'
)
logger.info(config.persona
  ? `已加载自定义人设${config.activePersona ? `「${config.activePersona}」` : ''}：${config.persona.split('\n')[0].slice(0, 40)}…`
  : `使用默认人设（名字：${config.botName}）`)
logger.info(`白名单群：${config.whitelistGroups.size > 0 ? [...config.whitelistGroups].join(', ') : '（未设置，群内仅被@时回复）'}`)
// 静音群要单独打出来：换号迁移期间靠它让旧号"完全冷备"，出问题时一眼能看出配没配上
if (config.mutedGroups && config.mutedGroups.size > 0) {
  logger.info(`静音群（连被@也不回）：${[...config.mutedGroups].join(', ')}`)
}
{
  // 把每个群实际生效的概率列出来，"哪个群为什么话少"一眼可见
  const desc = [...config.whitelistGroups]
    .map((g) => {
      const rate = config.proactiveRateFor(g)
      const custom = config.proactiveRatePerGroup.has(g) && rate !== config.proactiveRate ? ' 单独配置' : ''
      return `${g}: ${Math.round(rate * 100)}%${custom}`
    })
    .join('｜')
  logger.info(`白名单群主动搭话概率：${desc || `全局 ${Math.round(config.proactiveRate * 100)}%`}（冷却 ${Math.round(config.proactiveCooldownMs / 1000)}s）`)
}
logger.info(webSearch ? '联网搜索已启用（百度千帆，私聊/被@时模型按需调用）' : '联网搜索未启用（未配置 BAIDU_QIANFAN_API_KEY）')
logger.info(config.pokeEnabled ? `拍一拍回应已启用（冷却 ${Math.round(config.pokeCooldownMs / 1000)}s，语料 poke-replies.txt）` : '拍一拍回应未启用（POKE_REPLY_ENABLED=0）')
logger.info(config.autoPlusOneEnabled ? '自动+1已启用：仅白名单群，两条连续相同纯文字群友消息后原生跟一次；不受静音/安静时段限制，不调用模型' : '自动+1未启用（AUTO_PLUS_ONE_ENABLED=0）')
logger.info(config.longMemoryEnabled
  ? `长期记忆已启用（摘要上限 ${config.longMemoryMaxChars} 字，每 ${Math.round(config.longMemoryIntervalMs / 60000)} 分钟整理一次）`
  : '长期记忆未启用（LONG_MEMORY_ENABLED=0）')
logger.info(`上下文窗口：每个会话保留最近 ${config.historyLimit} 条${config.contextRememberAll ? '（含未回复的消息）' : ''}`)
logger.info(targetWatch.enabled
  ? `盯人回复已启用：群 ${targetWatch.groupId} 里的 ${targetWatch.userId}，每 ${Math.round(config.targetWatchIntervalMs / 1000)}s 检查一次`
  : '盯人回复未启用（TARGET_WATCH_ENABLED=0）')
logger.info(`反检测/拟人化：装饰符号保留 ${Math.round(config.emojiKeepRate * 100)}%｜打字延迟 ${config.humanDelayMinMs}-${config.humanDelayMaxMs}ms｜每会话每小时：主动/盯人 ≤${config.rateLimitPerHour} 条、被@或私聊 ≤${config.rateLimitAtPerHour} 条、间隔 ≥${Math.round(config.rateLimitMinGapMs / 1000)}s（不够时最多等 ${Math.round((config.rateLimitWaitMaxMs ?? 8000) / 1000)}s，不丢消息）｜${config.quietHours ? `安静时段 ${config.quietHours}（${config.quietHoursBlockAll ? '彻底静音：连被@和私聊都不回' : '只挡主动搭话，被@仍回'}）` : '安静时段未启用'}`)
logger.info(`群聊报告：${config.summarySendMode === 'forward' ? '合并转发成「聊天记录」卡片（失败自动退回逐条）' : '按空行逐条发送'}｜卡片最多 ${config.summaryMaxBlocks} 条｜统计数字由代码精确计算`)
logger.info(config.replyLengthMatch
  ? `回复长度自适应：跟着对方长度走｜最多 ${config.replyMaxLines} 行、单行 ≤${config.replyLineMaxChars} 字｜行间补句间隔 ${config.lineGapMinMs}-${config.lineGapMaxMs}ms｜多行时逐行分条发送`
  : '回复长度自适应已关闭（固定单行）')
logger.info(`OneBot 地址：${wsUrl}`)
logger.info(config.adminEnabled
  ? `机器人控制台：http://127.0.0.1:${config.adminPort}（双击桌面的「Koukou 控制台」即可打开）`
  : '机器人控制台未启用（ADMIN_ENABLED=0）')
logger.info(`会话独立设置：${chatSettings.keys().length} 个会话有单独配置（data/chat-settings.json）`)
logger.info(`定时指令：${dailyPing.describe()}`)
if (config.idCheckEnabled) {
  const where = config.idCheckGroups.length > 0 ? config.idCheckGroups.join(', ') : '（未限制群）'
  const who =
    config.idCheckOperators.length > 0 ? `仅限 QQ ${config.idCheckOperators.join('、')}` : '⚠ 任何人都能触发（ID_CHECK_OPERATORS 为空）'
  logger.info(`群名片核对已启用：群 ${where}｜${who}`)
}

dailySummary.schedule()
if (config.longMemoryEnabled) longMemory.start()
targetWatch.start()
dailyPing.schedule()

onebot.run().catch((err) => logger.error(`OneBot 运行失败：${err.message}`))
