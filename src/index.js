import { summaryRequestTimeout } from './summaryRequests.js'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { MemoryStore } from './memory.js'
import { DeepSeekClient, isQwenHybridModel } from './deepseek.js'
import { OneBotClient } from './onebot.js'
import { createBot, imageToDataUrl } from './bot.js'
import { createImageCache } from './imageCache.js'
import { loadVisionKnowledge, createGroundedVisionClient } from './visionKnowledge.js'
import { createVisionProviders } from './visionProviders.js'
import { createSummaryVisionClient } from './summaryReferences.js'
import { createDailySummary, buildSummaryPrompt } from './dailySummary.js'
import { createWebSearch } from './search.js'
import { createBackup } from './backup.js'
import { createSelfCheck } from './selfcheck.js'
import { createNotifier } from './notify.js'
import { createMetrics } from './metrics.js'
import { createImageHasher } from './imagehash.js'
import { createErrorStore } from './errorStore.js'
import { createPythonPlugins } from './pythonPlugins.js'
import { loadPokeReplies, createPokeReplier } from './pokeReplies.js'
import { createLongMemory } from './longMemory.js'
import { createCustomCommands } from './customCommands.js'
import { createCommandCenter } from './commandCenter.js'
import { createPersonaStickers } from './personaStickers.js'
import { createStickerLearner } from './stickerLearn.js'
import { createCustomCommandSchedule } from './customCommandSchedule.js'
import { createTargetWatch } from './targetWatch.js'
import { createChatSettings } from './chatSettings.js'
import { createDailyPing } from './dailyPing.js'
import { createQuietGreetings } from './quietGreetings.js'
import { createPersonaGreetingLibrary } from './personaGreetings.js'
import { createAdminServer } from './admin/server.js'
import { createRateLimiter } from './humanize.js'
import { createChatPromptBuilder } from './chatPrompt.js'

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
// 启动自愈：清掉历史遗留的“空壳群”键（不在白名单、也没有任何消息）。
// 以前 memory.get 会顺手创建空数组，没加白名单的群就会一直挂在会话列表里。
try {
  const allowed = new Set([...(config.whitelistGroups || [])].map(Number))
  for (const id of String(config.summaryGroups || '').split(/[,，\s]+/).filter(Boolean)) allowed.add(Number(id))
  let purged = 0
  for (const key of memory.keys()) {
    if (!/^g\d{1,24}$/.test(key)) continue
    if (allowed.has(Number(key.slice(1)))) continue
    if (memory.count(key) === 0) { memory.clearKey(key); purged++ }
  }
  if (purged) logger.info(`已清理 ${purged} 个空壳群会话`)
} catch (err) { logger.warn(`清理空壳群失败：${err.message}`) }

const llm = new DeepSeekClient({
  apiKey: config.deepseekApiKey,
  baseUrl: config.deepseekBaseUrl,
  model: config.deepseekModel,
  temperature: config.temperature,
  maxTokens: () => config.maxTokens,
  timeoutMs: config.timeoutMs,
  maxRetries: config.maxRetries,
  maxConcurrency: config.maxConcurrency,
  logger,
  label: 'DeepSeek',
  reasoningEffort: config.deepseekReasoningEffort,
})

// 视觉模型：消息带图片/表情包时先把图读成文字描述，再交给对话模型写人设回复。
//
// 谁来读图由 VISION_PROVIDER 决定（实测 2026-09-24，同一张真实群图各跑 3 轮）：
//   deepseek  → deepseek-flash  平均 1.9s，描述准确简洁（约 150 token）
//   dashscope → qwen3.7-flash   平均 40.4s，描述同样准确但每张图写 2000+ token
//   差的 21 倍几乎全在输出长度上 —— 提示词里写了"120 字以内"，qwen 并不照做。
// 注意：deepseek-v4-pro **不能读图**（会回"无法查看图片"），别拿它当视觉模型。
const visionKnowledge = loadVisionKnowledge(config.dataDir, logger)
// 多个自定义识图接口（存放在实例数据目录，不进仓库）
const visionProviders = createVisionProviders({
  file: path.join(config.dataDir, 'vision-providers.json'),
  logger,
  legacy: { baseUrl: config.visionCustomBaseUrl, apiKey: config.visionCustomApiKey, model: config.visionCustomModel },
})
if(config.visionProvider==='custom'&&visionProviders.list()[0])config.visionProvider='custom:'+visionProviders.list()[0].id
// 识图客户端：可在 DeepSeek 与通义千问之间热切换（不需要重启）
function customEndpoint(id) {
  const vp = id ? visionProviders.get(id) : null
  if (!vp || !vp.baseUrl || !vp.apiKey || !vp.model) return null
  return { provider: 'custom:' + vp.id, key: vp.apiKey, baseUrl: vp.baseUrl, model: vp.model || '', label: (vp.name || '自定义') + ' 识图', reasoningEffort: undefined, enableThinking: undefined }
}
function visionEndpoint(provider) {
  const raw = String(provider || 'deepseek')
  if (raw.startsWith('custom:')) return customEndpoint(raw.slice(7))
  const p = raw.toLowerCase()
  if (p === 'custom') {
    const first = visionProviders.list()[0]
    return first ? customEndpoint(first.id) : null
  }
  if (p === 'deepseek') {
    if (!config.deepseekApiKey) return null
    return {
      provider: 'deepseek', key: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl,
      model: config.visionModel || 'deepseek-flash', label: 'DeepSeek 视觉',
      // 识图不需要长思考：deepseek-flash 带思考时会把 max_tokens(300) 全烧在推理上，正文为空。
      reasoningEffort: /^deepseek.*flash/i.test(config.visionModel||'deepseek-flash')?'max':config.visionReasoning || 'none', enableThinking: undefined,
    }
  }
  if (!config.dashscopeApiKey) return null
  return {
    provider: 'dashscope', key: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
    model: config.dashscopeModel, label: '通义千问VL', reasoningEffort: undefined,
    // 识图强度独立于对话模型：none 关思考；low/high 交给混合模型开思考
    enableThinking: isQwenHybridModel(config.dashscopeModel) ? (config.visionReasoning === 'none' ? false : (config.visionReasoning ? true : config.dashscopeThinking)) : undefined,
  }
}
function makeClient(ep) {
  if (!ep) return null
  return new DeepSeekClient({
    apiKey: ep.key, baseUrl: ep.baseUrl, model: ep.model,
    temperature: config.temperature,
    maxTokens: Math.min(config.maxTokens, /^deepseek.*flash/i.test(ep.model)?Math.max(2048,config.visionMaxTokens||300):config.visionMaxTokens || 300),
    timeoutMs: config.timeoutMs, maxRetries: config.maxRetries,
    maxConcurrency: config.maxConcurrency, logger, label: ep.label,
    reasoningEffort: /^deepseek.*flash/i.test(ep.model)?'max':ep.reasoningEffort, enableThinking: ep.enableThinking,
  })
}
let visionActive = null
let lastVisionLabel = ''
function rebuildVision() {
  const ep = visionEndpoint(config.visionProvider)
  visionActive = createGroundedVisionClient(makeClient(ep), visionKnowledge, logger)
  const label = visionActive
    ? '视觉模型：' + visionActive.model + '（' + (ep ? ep.label : config.visionProvider) + '）'
    : '视觉模型未启用：' + config.visionProvider + ' 没有可用 Key'
  if (label !== lastVisionLabel) { lastVisionLabel = label; logger.info(label) }
  return visionActive
}
rebuildVision()
// 对外始终是同一个对象，调用时才取当前生效的客户端，所以切换后立即生效
const visionLLM = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'snapshot') return () => visionActive
    if (prop === 'provider') return config.visionProvider
    const target = visionActive
    if (!target) return undefined
    const value = target[prop]
    return typeof value === 'function' ? value.bind(target) : value
  },
  has(_t, prop) { return prop === 'provider' || Boolean(visionActive && prop in visionActive) },
})
if (visionKnowledge) logger.info(`[角色辨认] 已加载本地对照资料：${visionKnowledge.characters.length} 个角色、${visionKnowledge.references.length} 张参考图；缓存版本 ${visionKnowledge.version.slice(0, 12)}`)
const useQwenForSummary = Boolean(config.summaryModel) && config.summaryProvider === 'dashscope'
const summaryLLM = new DeepSeekClient({
  apiKey: useQwenForSummary ? config.dashscopeApiKey : llm.apiKey,
  baseUrl: useQwenForSummary ? config.dashscopeBaseUrl : llm.baseUrl,
  model: config.summaryModel || llm.model,
  temperature: 1.0,
  maxTokens: config.summaryUnrestricted ? undefined : config.summaryMaxTokens,
  timeoutMs: summaryRequestTimeout(config, Math.max(config.timeoutMs, 180000)),
  maxRetries: config.maxRetries,
  maxConcurrency: config.summaryConcurrency,
  logger,
  label: useQwenForSummary ? '总结模型(通义千问)' : '总结模型(DeepSeek)',
  reasoningEffort: useQwenForSummary ? undefined : config.deepseekReasoningEffort,
  enableThinking: useQwenForSummary && isQwenHybridModel(config.summaryModel) ? config.dashscopeThinking : undefined,
})

const wsUrl = config.onebotAccessToken
  ? `${config.onebotWsUrl}${config.onebotWsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(config.onebotAccessToken)}`
  : config.onebotWsUrl

const onebot = new OneBotClient({ url: wsUrl, logger, probeUserId: config.idCheckOperators?.[0] || config.dailyPingTarget })
// 备份 / 自检 / 异常通知
const backupService = createBackup({ config, logger })
const notifier = createNotifier({ config, onebot, logger, file: path.join(config.dataDir, 'notifications.json') })
const selfCheck = createSelfCheck({ config, onebot, backup: backupService, logger })
const metricsService = createMetrics({ file: path.join(config.dataDir, 'metrics.json'), logger })
const stickerHasher = createImageHasher({ config, logger })
const errorStore = createErrorStore({ file: path.join(config.dataDir, 'errors.json') })
const pythonPlugins = createPythonPlugins({ config, logger, pythonPath: process.env.PYTHON_PATH || 'python' })
// 所有 logger.error 都计入当天错误数（用于失败率曲线）
{
  const rawError = logger.error.bind(logger)
  logger.error = (...args) => {
    try { metricsService.error() } catch {}
    const text = args.map((x) => (x && x.stack) || String(x)).join(' ')
    try { errorStore.add(text, 'bot', 'error') } catch {}
    try {
      if (/余额|额度|quota|429|401|403|请求参数错误|超时|timeout|ECONN|socket hang up/i.test(text)) {
        notifier.notify('model-health', '模型调用可能异常：' + text.replace(/\s+/g, ' ').slice(0, 180)).catch(() => {})
      }
    } catch {}
    rawError(...args)
  }
  const rawWarn = logger.warn.bind(logger)
  logger.warn = (...args) => {
    try { errorStore.add(args.map((x) => (x && x.stack) || String(x)).join(' '), 'bot', 'warn') } catch {}
    rawWarn(...args)
  }
}
const sharedImageCache = config.dataDir && config.visionCacheEnabled !== false ? createImageCache({
  dir: path.join(config.dataDir, 'image-cache'), maxBytes: config.visionCacheMaxBytes,
  maxEntries: config.visionCacheMaxEntries, maxImageBytes: config.visionMaxImageBytes,
  ttlMs: config.visionCacheTtlMs, logger,
}) : null
const summaryVisionLLM = createGroundedVisionClient(createSummaryVisionClient({ config, logger }), visionKnowledge, logger)

// 长期记忆：把被近期窗口挤出去的旧消息压缩成持续累积的摘要（用便宜的总结模型）
// 共享型号与设置，但不共享并发队列；记忆整理不能占住定时群总结的等待位置。
const memoryLLM = new DeepSeekClient({
  apiKey: summaryLLM.apiKey, baseUrl: summaryLLM.baseUrl, model: summaryLLM.model,
  temperature: summaryLLM.temperature, maxTokens: config.summaryMaxTokens,
  timeoutMs: Math.max(config.timeoutMs,180000), maxRetries: summaryLLM.maxRetries, maxConcurrency: 1,
  enableThinking: summaryLLM.enableThinking, reasoningEffort: summaryLLM.reasoningEffort, logger, label: '长期记忆模型',
})
const longMemory = createLongMemory({
  file: path.join(config.dataDir, 'long-memory.json'),
  logger,
  llm: { chat: (prompt, messages, options) => memoryLLM.chat(prompt, messages, options) },
  maxChars: config.longMemoryMaxChars,
  intervalMs: config.longMemoryIntervalMs,
})
memory.onEvict = (key, entries) => longMemory.addEvicted(key, entries)

// 自定义指令：关键词命中回固定内容（含变量替换）与定时推送，不调用模型
const customCommands = createCustomCommands({ file: path.join(config.dataDir, 'custom-commands.json'), logger })

// 表情包库：图片存 data/stickers，模型可用 [贴纸: 名称] 指定发送
const chatSettings = createChatSettings({ file: path.join(config.dataDir, 'chat-settings.json'), logger })
const stickers = createPersonaStickers({ dir: path.join(config.dataDir, 'stickers'), config, chatSettings, memory, logger })
const stickerFilterLLM = config.deepseekApiKey ? new DeepSeekClient({
  apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl, model: 'deepseek-flash',
  reasoningEffort: 'max', temperature: 0.2, maxTokens: undefined,
  timeoutMs: Math.max(config.timeoutMs, 180000), maxRetries: config.maxRetries,
  maxConcurrency: 1, logger, label: '表情包初筛(DeepSeek Flash)',
}) : null
// 打标优先用 DashScope；没有 Key 时回退到 DeepSeek 读图（实测 1 秒、描述准确），
// 这样表情包学习不需要额外申请 DashScope。
let tagActive = null
let lastTagLabel = ''
function rebuildStickerTag() {
  const prefer = String(config.stickerTagProvider || 'auto').toLowerCase()
  const chain = prefer === 'auto' ? ['dashscope', 'deepseek', 'custom'] : [prefer]
  let ep = null
  for (const p of chain) { ep = visionEndpoint(p); if (ep) break }
  tagActive = makeClient(ep)
  const label = tagActive
    ? '表情包打标：' + tagActive.model + '（' + (ep ? ep.label : '?') + '）'
    : '表情包打标未启用：没有可用的识图模型'
  if (label !== lastTagLabel) { lastTagLabel = label; logger.info(label) }
  return tagActive
}
rebuildStickerTag()
const stickerTagLLM = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'snapshot') return () => tagActive
    const target = tagActive
    if (!target) return undefined
    const value = target[prop]
    return typeof value === 'function' ? value.bind(target) : value
  },
  has(_t, prop) { return Boolean(tagActive && prop in tagActive) },
})
const stickerLearner = createStickerLearner({ config, logger, onebot, stickers,
  similar: async (dataUrl) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(String(dataUrl || ''))
    if (!m) return false
    const buf = Buffer.from(m[2], 'base64')
    const tmp = path.join(config.dataDir, 'tmp-similar-' + process.pid + '-' + Date.now() + '.img')
    try {
      writeFileSync(tmp, buf)
      await stickerHasher.hashFiles([tmp])
      const h = stickerHasher.hashOf({ file: path.basename(tmp) })
      if (!h) return false
      const files = (stickers.list() || []).map((x) => path.join(stickers.dir, x.file)).filter((f) => existsSync(f))
      await stickerHasher.hashFiles(files)
      return (stickers.list() || []).some((item) => {
        const other = stickerHasher.hashOf(item)
        return other && stickerHasher.distance(h, other) <= 8
      })
    } catch { return false } finally { try { rmSync(tmp, { force: true }) } catch {} }
  },
  filterLLM: stickerFilterLLM, tagLLM: stickerTagLLM, imageCache: sharedImageCache })
const commandCenter = createCommandCenter({file:path.join(config.dataDir,'command-center.json'),customCommands,config,logger,llm})

// 联网搜索：仅私聊与被@时可用，由模型自己判断这句话要不要搜
const webSearchState = { enabled: config.webSearchEnabled !== false, model: config.webSearchModel, provider: config.webSearchProvider }
let webSearchImpl = null
function resolveSearchProvider(configured, model) {
  return String(configured || 'auto').toLowerCase()
}
function rebuildWebSearch() {
  try{webSearchImpl = createWebSearch({
    apiKey: config.baiduApiKey,
    dashscopeApiKey: config.dashscopeApiKey,
    deepseekApiKey: config.deepseekApiKey,
    dashscopeModel: webSearchState.model,
    provider: webSearchState.enabled ? resolveSearchProvider(webSearchState.provider, webSearchState.model) : 'off',
    timeoutMs: 20000,
    logger,
  })}catch(error){webSearchImpl=null;logger.warn('联网搜索暂不可用：'+error.message)}
}
rebuildWebSearch()
const webSearch = async (query) => {
  if (!webSearchState.enabled) throw new Error('联网搜索已关闭')
  if (!webSearchImpl) throw new Error('联网搜索未启用')
  return webSearchImpl(query)
}
Object.defineProperty(webSearch, 'isEnabled', { get: () => Boolean(webSearchState.enabled && webSearchImpl) })
Object.defineProperty(webSearch, 'providerName', { get: () => (webSearchImpl && webSearchImpl.providerName) || 'off' })
webSearch.setOptions = (patch) => {
  if (patch && patch.provider) webSearchState.provider = patch.provider
  if (patch && 'enabled' in patch) webSearchState.enabled = Boolean(patch.enabled)
  if (patch && patch.model) webSearchState.model = String(patch.model).trim() || webSearchState.model
  rebuildWebSearch()
  logger?.info?.('[控制台] 联网搜索已更新：' + (webSearchState.enabled ? ('开启（' + webSearch.providerName + '，' + webSearchState.model + '）') : '关闭'))
  return { enabled: webSearchState.enabled, model: webSearchState.model, provider: webSearch.providerName }
}

// 总结提示词：先注入当前实例人格，再给出报告格式与统计要求。
const summaryPromptFn = (opts) => {
  const personaPart = config.persona
    ? `${config.persona}\n\n（注意：现在是在写「群聊日常分析报告」，不是日常聊天——上面人设里"一两句话、别长篇大论、回复长度跟着对方走"等聊天规则不适用于报告场景，口吻和语气保持一致即可，篇幅与格式以下面的报告要求为准。）\n\n`
    : ''
  return `${personaPart}${buildSummaryPrompt(opts)}`
}

// 总结调用：失败直接抛出（由上层通知群里），不用聊天模型兜底（其 token 预算远不够写长文）
const summaryChat = async (prompt, messages, options) => summaryLLM.chat(prompt, messages, options)

const dailySummary = createDailySummary({ config, logger, onebot, llm: { chat: summaryChat },
  visionLLM: summaryVisionLLM, imageCache: sharedImageCache,
  loadImage: (image, signal) => imageToDataUrl(image, onebot, config, logger, {signal}), buildSummaryPromptFn: summaryPromptFn })

const systemPrompt = createChatPromptBuilder({ config, longMemory, todayNote: key => dailyPing?.todayNote?.(key) ?? '' })

// 拍一拍回复语（poke-replies.txt，可自行增删）
const pokeLines = loadPokeReplies(config.rootDir, logger, config.pokeRepliesFile)
const pokeReplier = createPokeReplier(pokeLines)

// 盯人回复：定期检查目标群里指定用户是否发过言，有则 @ 他回一两句
const replyLog = new Map() // `${groupId}:${userId}` -> 上次回复时间戳
// 反检测限流：所有发送路径共用（每个会话每小时上限 + 最小间隔）
const rateLimiter = createRateLimiter({ perHour: config.rateLimitPerHour, minGapMs: config.rateLimitMinGapMs })
const targetWatch = createTargetWatch({ config, logger, onebot, llm, memory, buildSystemPrompt: systemPrompt, replyLog, rateLimiter, longMemory, chatSettings })

// 定时指令：按配置时点到指定群 @ 目标账号，发送固定内容。
const dailyPing = createDailyPing({
  config,
  logger,
  onebot,
  rateLimiter,
  memory,
  stateFile: path.join(config.dataDir, 'daily-ping-state.json'),
})

// 每个会话（群/私聊）的独立设置：控制台里改，存 data/chat-settings.json，改完立刻生效

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

const bot = createBot({
    metrics: metricsService,
    pythonPlugins, config, logger, onebot, llm, visionLLM, imageCache: sharedImageCache, memory, buildSystemPrompt: systemPrompt, dailySummary, dailyPing, webSearch, pokeReplier, targetWatch, replyLog, rateLimiter, chatSettings, runtimeStats, customCommands, commandCenter, longMemory, stickers, stickerLearner })

// 固定语库调度不使用模型；语库与人格正文绑定，发送状态与迁移语库分开保存。
const personaGreetings=createPersonaGreetingLibrary({file:path.join(config.dataDir,'persona-greetings.json'),logger})
const quietGreetings=createQuietGreetings({config,onebot,chatSettings,memory,logger,library:personaGreetings,
  file:path.join(config.dataDir,'quiet-greetings-state.json')})

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
    quietGreetings, personaGreetings,
    bot,
    customCommands,
    llm,
    stickers,
    commandCenter,
    stickerTagLLM,
    switchVision: () => { rebuildVision(); rebuildStickerTag() },
    webSearch,
    switchWebSearch: (patch) => webSearch.setOptions(patch),
    backup: backupService,
    metrics: metricsService,
    selfcheck: selfCheck,
    pokeReplies: { lines: pokeLines },
    pythonPlugins,
    errors: errorStore,
    visionProviders,
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

// 自动备份：启动 1 分钟后检查一次，之后每 6 小时检查；一天内已有备份就跳过。
function maybeBackup(reason) {
  try {
    if (Date.now() - backupService.lastBackupAt() < 20 * 3600 * 1000) return
    const result = backupService.run({ reason })
    notifier.notify('backup-ok', '已自动备份记忆与表情包：' + result.name, { minIntervalMs: 20 * 3600 * 1000 }).catch(() => {})
  } catch (err) { logger.warn('自动备份失败：' + err.message) }
}
setTimeout(() => maybeBackup('startup'), 60 * 1000).unref?.()
setInterval(() => maybeBackup('auto'), 6 * 3600 * 1000).unref?.()

// 掉线提醒：连续两次检测不到 OneBot 才通知，避免抖动刷屏。
let offlineTicks = 0
setInterval(() => {
  try {
    const st = onebot.status()
    if (st && st.connected) { offlineTicks = 0; return }
    offlineTicks += 1
    if (offlineTicks === 2) notifier.notify('onebot-offline', 'OneBot 连接断开（3001），机器人暂时收不到消息').catch(() => {})
  } catch {}
}, 2 * 60 * 1000).unref?.()

// 独立持久化发送状态，重启后先核对已发送/待核验记录。
const customSchedule = createCustomCommandSchedule({
  file: path.join(config.dataDir, 'custom-command-delivery.json'), commands: customCommands,
  onebot, memory, rateLimiter, logger,
})
customSchedule.start()

// 事件循环看门狗：正常每秒最多延迟几十毫秒；超过 1.5 秒说明有同步代码卡住，
// 恢复后会打一条带时间的告警，方便定位是哪一步（控制台 / 消息处理）把进程卡死。
let lastTickAt = Date.now()
const watchdog = setInterval(() => {
  const now = Date.now()
  const lag = now - lastTickAt - 1000
  lastTickAt = now
  if (lag > 1500) logger.warn(`[看门狗] 事件循环被阻塞约 ${(lag / 1000).toFixed(1)} 秒（${new Date().toLocaleTimeString()}）`)
}, 1000)
if (watchdog.unref) watchdog.unref()

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
  quietGreetings.stop()
  customSchedule.stop()
  dailySummary.stop()
  onebot.stop()
  setTimeout(() => process.exit(0), 300).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.on('unhandledRejection', (err) => { logger.error(`未处理的 Promise 拒绝：${err?.stack || err}`); notifier.notify('crash', '未处理的 Promise 拒绝：' + String(err?.message || err).slice(0, 200)).catch(() => {}) })
process.on('uncaughtException', (err) => { logger.error(`未捕获异常：${err?.stack || err}`); notifier.notify('crash', '未捕获异常：' + String(err?.message || err).slice(0, 200)).catch(() => {}) })

logger.info('===== DeepSeek × QQ 机器人启动 =====')
logger.info(`模型：${config.deepseekModel}｜DeepSeek思考强度：${config.deepseekReasoningEffort ?? '服务端默认'}`)
if (config.deepseekReasoningEffort && config.deepseekReasoningEffort !== 'none' && config.maxTokens < 800) {
  logger.warn(`思考强度开启但 MAX_TOKENS=${config.maxTokens} 偏小：思考会占用输出预算，建议 ≥ 1200（否则可能出现空回复）`)
}
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
logger.info(webSearch.isEnabled ? `联网搜索已启用（${{baidu:'百度千帆',deepseek:'DeepSeek 搜索',dashscope:'通义千问 API',bing:'必应网页兜底'}[webSearch.providerName] || webSearch.providerName}，私聊/被@时由模型自行决定要不要搜）` : '联网搜索未启用（控制台已关闭，或 WEB_SEARCH_PROVIDER=off）')
logger.info(commandCenter.enabled('poke') ? `拍一拍回应已启用（冷却 ${Math.round(config.pokeCooldownMs / 1000)}s，语料 poke-replies.txt）` : '拍一拍回应未启用（POKE_REPLY_ENABLED=0）')
logger.info(commandCenter.enabled('auto-plus-one') ? '自动+1已启用：仅白名单群，两条连续相同文字、emoji、QQ自带表情或任意混合消息后原生跟一次；图片和图片表情包不跟读，不受静音/安静时段限制，不调用模型' : '自动+1未启用（AUTO_PLUS_ONE_ENABLED=0）')
logger.info(config.longMemoryEnabled
  ? `长期记忆已启用（摘要上限 ${config.longMemoryMaxChars} 字，每 ${Math.round(config.longMemoryIntervalMs / 60000)} 分钟整理一次）`
  : '长期记忆未启用（LONG_MEMORY_ENABLED=0）')
logger.info(`上下文窗口：每个会话保留最近 ${config.historyLimit} 条${config.contextRememberAll ? '（含未回复的消息）' : ''}`)
logger.info(targetWatch.enabled
  ? `盯人回复已启用：群 ${targetWatch.groupId} 里的 ${targetWatch.userId}，每 ${Math.round(config.targetWatchIntervalMs / 1000)}s 检查一次`
  : '盯人回复未启用（TARGET_WATCH_ENABLED=0）')
logger.info(`反检测/拟人化：装饰符号保留 ${Math.round(config.emojiKeepRate * 100)}%｜打字延迟 ${config.humanDelayMinMs}-${config.humanDelayMaxMs}ms｜每会话每小时：主动/盯人 ≤${config.rateLimitPerHour} 条、被@或私聊 ≤${config.rateLimitAtPerHour} 条、间隔 ≥${Math.round(config.rateLimitMinGapMs / 1000)}s（不够时最多等 ${Math.round((config.rateLimitWaitMaxMs ?? 8000) / 1000)}s，不丢消息）｜${config.quietHours ? `安静时段 ${config.quietHours}（${config.quietHoursBlockAll ? '彻底静音：连被@和私聊都不回' : '只挡主动搭话，被@仍回'}）` : '安静时段未启用'}`)
logger.info(`群聊报告：${config.summarySendMode === 'forward' ? '合并转发成「聊天记录」卡片（失败自动退回逐条）' : '按空行逐条发送'}｜卡片最多 ${config.summaryMaxBlocks} 条｜统计数字由代码精确计算`)
logger.info(`总结调度：最多 ${config.summaryConcurrency} 群并行准备｜${config.summaryUnrestricted?`宽裕模式：不设本地输入取样、输出token及总准备时限；单次模型等待${config.summaryRequestTimeoutSeconds}秒`:`单群准备时限 ${config.summaryTaskTimeoutMinutes} 分钟`}｜报告发送串行，群间至少间隔 5 秒`)
logger.info(`总结转发资料：先筛选群内关联再展开嵌套记录，仅作低权重参考｜读图 ${summaryVisionLLM ? `${summaryVisionLLM.model}（通义千问）` : '未启用，缺少 DashScope Key'}｜每份最多 ${config.summaryReferenceMaxImages} 张参考图片`)
logger.info(config.replyLengthMatch
  ? `回复长度自适应：跟着对方长度走｜最多 ${config.replyMaxLines} 行、单行 ≤${config.replyLineMaxChars} 字｜行间补句间隔 ${config.lineGapMinMs}-${config.lineGapMaxMs}ms｜多行时逐行分条发送`
  : '回复长度自适应已关闭（固定单行）')
logger.info(`OneBot 地址：${wsUrl}`)
logger.info(config.adminEnabled
  ? `机器人控制台：http://127.0.0.1:${config.adminPort}（双击桌面的「Koukou 控制台」即可打开）`
  : '机器人控制台未启用（ADMIN_ENABLED=0）')
logger.info(`会话独立设置：${chatSettings.keys().length} 个会话有单独配置（data/chat-settings.json）`)
logger.info(`定时指令：${dailyPing.describe()}`)
logger.info(`固定语库早晚安：${config.quietGreetingsEnabled?'已启用（不调用AI）':'未启用'}；语库就绪 ${quietGreetings.status().groups.filter(g=>g.ready).length}/${quietGreetings.status().groups.length} 群`)
if (config.idCheckEnabled) {
  const where = config.idCheckGroups.length > 0 ? config.idCheckGroups.join(', ') : '（未限制群）'
  const who =
    config.idCheckOperators.length > 0 ? `仅限 QQ ${config.idCheckOperators.join('、')}` : '⚠ 任何人都能触发（ID_CHECK_OPERATORS 为空）'
  logger.info(`群名片核对已启用：群 ${where}｜${who}`)
}
logger.info(`管理员（ADMIN_USERS）：${config.adminUsers.length ? config.adminUsers.join('、') : '未配置（群总结等沿用公开范围；QQ 清除记忆指令不可用）'}`)
{
  const cmds = typeof customCommands?.all === 'function' ? customCommands.all() : []
  const sched = cmds.filter((c) => c.scheduleEnabled && (c.scheduleTimes || []).length).length
  logger.info(`自定义指令：${cmds.length} 条${sched ? `（其中 ${sched} 条带定时推送）` : ''}`)
  logger.info(`表情包：${stickers.count()} 张${config.stickersEnabled ? '' : '（已关闭）'}${config.stickerLearnEnabled ? `｜群聊学习开启（每小时 ${config.stickerLearnPerHour} 张）` : ''}${config.stickerAutoRate > 0 ? `｜主动发 ${Math.round(config.stickerAutoRate * 100)}%` : ''}${stickerTagLLM ? `｜打标 ${stickerTagLLM.model}` : ''}`)
}

dailySummary.schedule()
if (config.longMemoryEnabled) longMemory.start()
targetWatch.start()
dailyPing.schedule()
quietGreetings.start()

onebot.run().catch((err) => logger.error(`OneBot 运行失败：${err.message}`))
