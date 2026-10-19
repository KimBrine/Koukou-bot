import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLocalProfile } from './localProfile.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')

/**
 * 实例隔离：一份代码可以同时跑两个机器人（每个连一个 QQ 账号）。
 *
 * 为什么需要：换号迁移期间旧号要继续服务"新号还没进的群"，而一个进程只能连一个 OneBot，
 * 所以必须两个进程。但**绝不能复制一份代码目录** —— 那样以后每修一个 bug 都要改两遍。
 * 于是用这几个环境变量把「配置 / 数据 / 日志」分开，代码目录仍然只有一份：
 *   BOT_ENV_FILE  用哪个 .env（默认 <代码目录>/.env）
 *   BOT_DATA_DIR  数据放哪（默认 <代码目录>/data）—— 分开才不会抢 bot.lock、才不会串记忆
 *   BOT_LOG_DIR   日志放哪（默认 <代码目录>/logs）—— 否则两个实例的 bot.log 会交织在一起
 *   BOT_PROFILE   实例名（main / new），用于重启时只杀自己的进程
 */
const envFile = process.env.BOT_ENV_FILE ? path.resolve(process.env.BOT_ENV_FILE) : path.join(ROOT_DIR, '.env')
/** 本实例实际读取的 .env 路径（控制台读/写配置必须用它，否则会串到另一个实例的配置） */
export const ENV_FILE = envFile
export const DATA_DIR = process.env.BOT_DATA_DIR ? path.resolve(process.env.BOT_DATA_DIR) : path.join(ROOT_DIR, 'data')
export const LOG_DIR = process.env.BOT_LOG_DIR ? path.resolve(process.env.BOT_LOG_DIR) : path.join(ROOT_DIR, 'logs')

function parseEnvFile(filePath) {
  const out = {}
  if (!existsSync(filePath)) return out
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (key.startsWith('export ')) key = key.slice(7).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// 真实环境变量优先级高于 .env 文件
const env = { ...parseEnvFile(envFile), ...process.env }

const num = (key, fallback) => {
  const v = Number(env[key])
  return Number.isFinite(v) ? v : fallback
}

export const PERSONA_DIR = env.PERSONA_DIR ? path.resolve(path.dirname(envFile), env.PERSONA_DIR) : path.join(DATA_DIR, 'personas')

/** 自定义人设：环境变量 > 本实例选定人格 > 指定文件 > 本实例默认文件 > 通用模板。 */
function readPersona() {
  const explicit = env.PERSONA ? String(env.PERSONA).trim() : ''
  if (explicit) return explicit
  // 每个实例的人格库独立；不自动扫描仓库中的旧人格或参考包。
  const active = String(env.ACTIVE_PERSONA ?? '').trim()
  if (active) {
    if (/[\\/:*?"<>|\u0000-\u001f]/.test(active) || /[. ]$/.test(active)) throw new Error('当前人格名称无效')
    const file = path.join(PERSONA_DIR, `${active}.txt`)
    if (existsSync(file)) {
      try {
        const text = readFileSync(file, 'utf8').trim()
        if (text) return text
        throw new Error('当前人格正文为空')
      } catch {
        throw new Error('读取当前实例人格失败')
      }
    } else throw new Error('当前实例的选定人格不存在，请导入或迁移人格文件')
  }
  const file = env.PERSONA_FILE ? path.resolve(path.dirname(envFile), env.PERSONA_FILE)
    : existsSync(path.join(DATA_DIR, 'persona.txt')) ? path.join(DATA_DIR, 'persona.txt') : path.join(ROOT_DIR, 'persona.txt')
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, 'utf8').trim()
      if (text) return text.replaceAll('{{BOT_NAME}}', String(env.BOT_NAME || 'Koukou'))
    } catch {
      /* 读取失败走默认人设 */
    }
  }
  return ''
}

export function loadConfig() {
  const localProfile = readLocalProfile(DATA_DIR)
  const whitelist = new Set(
    String(env.WHITELIST_GROUPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
  )
  const proactiveRate = Math.min(1, Math.max(0, num('PROACTIVE_RATE', 0.1)))

  /**
   * 按群独立配置主动搭话概率，形如 PROACTIVE_RATE_PER_GROUP=200000019:0.35,200000017:0.3
   * 未列出的群回落到 PROACTIVE_RATE；盯人（TARGET_WATCH_GROUP）是独立机制，不受这里影响。
   */
  const proactiveRatePerGroup = new Map()
  for (const piece of String(env.PROACTIVE_RATE_PER_GROUP ?? '').split(',')) {
    const [gid, rate] = piece.split(':').map((s) => s.trim())
    const g = Number(gid)
    const r = Number(rate)
    if (Number.isFinite(g) && g > 0 && Number.isFinite(r)) {
      proactiveRatePerGroup.set(g, Math.min(1, Math.max(0, r)))
    }
  }

  /** 取某个群的主动搭话概率（独立配置优先） */
  const proactiveRateFor = (groupId) => {
    const g = Number(groupId)
    return proactiveRatePerGroup.has(g) ? proactiveRatePerGroup.get(g) : proactiveRate
  }

  return {
    rootDir: ROOT_DIR,
    dataDir: DATA_DIR,
    logDir: LOG_DIR,
    // 控制台读/写配置用的 .env —— 必须是**本实例**那一份。
    // 曾经写死成 rootDir/.env，导致在"新号"控制台里改设置会改到旧号的配置文件上。
    envFile: ENV_FILE,
    memoryFile: path.join(DATA_DIR, 'memory.json'),
    logFile: path.join(LOG_DIR, 'bot.log'),

    // 实例身份：重启时只杀自己这个 profile 的进程，并拉起自己的计划任务。
    // 两个实例并行时，这是"按一下重启不会把另一个也弄死"的唯一依据。
    botProfile: String(env.BOT_PROFILE ?? 'main').trim() || 'main',
    botTaskName: String(env.BOT_TASK_NAME ?? 'DeepSeekQQBot').trim(),

    // NapCat 实例身份：并行跑第二个机器人时，控制台的"重启 NapCat"必须打到**自己那一套**，
    // 否则在新控制台点一下会把旧号重启掉（旧号正跑着生产流量）。
    napcatDir: String(env.NAPCAT_DIR ?? '').trim(),
    napcatTaskName: String(env.NAPCAT_TASK_NAME ?? 'NapCatQQ').trim(),

    // 静音群：在这些群里**完全不出声，连被 @ 也不回**。
    // 换号迁移期间用：新号接管的群，旧号必须彻底闭嘴 —— 白名单只管"主动搭话"，
    // 管不住"群内被@必回"，所以需要这个独立的闸门。
    mutedGroups: new Set(
      String(env.MUTED_GROUPS ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),

    deepseekApiKey: String(env.DEEPSEEK_API_KEY ?? '').trim(),
    deepseekBaseUrl: String(env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    deepseekModel: String(env.DEEPSEEK_MODEL ?? 'deepseek-chat'),
    deepseekReasoningEffort: String(env.DEEPSEEK_REASONING_EFFORT ?? '').trim().toLowerCase() || undefined,

    // 视觉模型（通义千问 DashScope，OpenAI 兼容模式），用于读图/表情包
    // 用哪个服务商读图：deepseek（实测快 21 倍）或 dashscope。见 src/index.js 顶部的实测数据。
    visionProvider: String(env.VISION_PROVIDER ?? 'dashscope').trim().toLowerCase(),
    // provider=deepseek 时读图用哪个模型（deepseek-v4-pro **不能读图**，别填它）
    visionModel: String(env.VISION_MODEL ?? 'deepseek-flash').trim(),
    dashscopeApiKey: String(env.DASHSCOPE_API_KEY ?? '').trim(),
    dashscopeBaseUrl: String(env.DASHSCOPE_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    dashscopeModel: String(env.DASHSCOPE_MODEL ?? 'qwen-vl-plus'),
    dashscopeThinking: ['1', 'true'].includes(String(env.DASHSCOPE_ENABLE_THINKING ?? '0').trim().toLowerCase()),
    visionMaxImages: Math.max(1, Math.min(9, Math.floor(num('VISION_MAX_IMAGES', 4)))),
    visionMaxImageBytes: Math.max(100000, Math.floor(num('VISION_MAX_IMAGE_BYTES', 6 * 1024 * 1024))),
    visionImageTimeoutMs: Math.max(5000, Math.floor(num('VISION_IMAGE_TIMEOUT_MS', 20000))),
    visionCacheEnabled: !['0', 'false'].includes(String(env.VISION_CACHE_ENABLED ?? '1').toLowerCase()),
    visionCacheMaxBytes: Math.max(1, num('VISION_CACHE_MAX_MB', 256)) * 1024 * 1024,
    visionCacheMaxEntries: Math.max(1, Math.floor(num('VISION_CACHE_MAX_ENTRIES', 2000))),
    visionCacheTtlMs: Math.max(1, num('VISION_CACHE_DAYS', 30)) * 86400000,

    // 每日群聊总结
    summaryEnabled: String(env.SUMMARY_ENABLED ?? '1').toLowerCase() !== '0' && String(env.SUMMARY_ENABLED ?? '1').toLowerCase() !== 'false',
    summaryFallbackEnabled: ['1', 'true'].includes(String(env.SUMMARY_FALLBACK_ENABLED ?? '0').trim().toLowerCase()),
    summaryTimes: String(env.SUMMARY_TIMES ?? '23:00')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{1,2}:\d{2}$/.test(s)),
    summaryGroups: String(env.SUMMARY_GROUPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
    summaryMaxMessages: Math.max(50, Math.min(2000, Math.floor(num('SUMMARY_MAX_MESSAGES', 600)))),
    summaryBotUsers: String(env.SUMMARY_BOT_USERS??'').split(/[\s,，]+/).filter(id=>/^\d{1,15}$/.test(id)),
    summaryUnrestricted: /^(?:1|true)$/i.test(String(env.SUMMARY_UNRESTRICTED??'0')),
    summaryRequestTimeoutSeconds: Math.max(60, Math.min(3600, Math.floor(num('SUMMARY_REQUEST_TIMEOUT_SECONDS', 900)))),
    summaryModel: String(env.SUMMARY_MODEL ?? '').trim() || null,
    // 总结模型提供方：deepseek | dashscope（DashScope/通义千问在长文总结上更稳，不会把预算烧在推理里）
    summaryProvider: String(env.SUMMARY_PROVIDER ?? 'deepseek').toLowerCase(),
    summaryMaxTokens: Math.max(500, Math.min(16000, Math.floor(num('SUMMARY_MAX_TOKENS', 8000)))),
    summaryConcurrency: Math.max(1, Math.min(3, Math.floor(num('SUMMARY_CONCURRENCY', 2)))),
    summaryTaskTimeoutMinutes: Math.max(2, Math.min(30, Math.floor(num('SUMMARY_TASK_TIMEOUT_MINUTES', 6)))),
    summaryVisionModel: String(env.SUMMARY_VISION_MODEL ?? '').trim() || String(env.DASHSCOPE_MODEL ?? 'qwen-vl-plus').trim(),
    summaryReferenceMaxImages: Math.max(0, Math.min(12, Math.floor(num('SUMMARY_REFERENCE_MAX_IMAGES', 6)))),
    // 报告发送方式：先按空行分段。forward（合并转发成"聊天记录"卡片，失败自动退回逐条）| split（逐段发送）
    summarySendMode: String(env.SUMMARY_SEND_MODE ?? 'forward').toLowerCase() === 'split' ? 'split' : 'forward',
    // 单张合并转发卡片最多几个节点；超出时分成多张卡片
    summaryMaxBlocks: Math.max(3, Math.min(50, Math.floor(num('SUMMARY_MAX_BLOCKS', 20)))),
    // 喂给模型的"每人数据"行数
    summaryUserRows: Math.max(3, Math.min(50, Math.floor(num('SUMMARY_USER_ROWS', 20)))),

    onebotWsUrl: String(env.ONEBOT_WS_URL ?? 'ws://127.0.0.1:3001'),
    onebotAccessToken: String(env.ONEBOT_ACCESS_TOKEN ?? '').trim(),

    botName: String(env.BOT_NAME ?? 'Koukou').trim() || 'Koukou',
    persona: readPersona(),
    personaDir: PERSONA_DIR,
    localProfile,
    pokeRepliesFile: env.POKE_REPLIES_FILE ? path.resolve(path.dirname(envFile), env.POKE_REPLIES_FILE) : path.join(DATA_DIR, 'poke-replies.txt'),
    activePersona: String(env.ACTIVE_PERSONA ?? '').trim(),
    // 控制台（本地管理界面）
    adminEnabled: String(env.ADMIN_ENABLED ?? '1').toLowerCase() !== '0' && String(env.ADMIN_ENABLED ?? '1').toLowerCase() !== 'false',
    adminPort: Math.max(1024, Math.min(65535, Math.floor(num('ADMIN_PORT', 8787)))),

    whitelistGroups: whitelist,
    proactiveRate,
    // 按群独立概率（Map<群号, 概率>）与取值函数
    proactiveRatePerGroup,
    proactiveRateFor,
    // 白名单群主动搭话最短间隔（毫秒，0=不限制）
    proactiveCooldownMs: Math.max(0, Math.floor(num('PROACTIVE_COOLDOWN_MS', 180000))),

    // 联网搜索（百度千帆 AI Search）
    baiduApiKey: String(env.BAIDU_QIANFAN_API_KEY ?? '').trim(),

    // 拍一拍回应（双击头像）
    pokeEnabled: String(env.POKE_REPLY_ENABLED ?? '1').toLowerCase() !== '0' && String(env.POKE_REPLY_ENABLED ?? '1').toLowerCase() !== 'false',
    pokeCooldownMs: Math.max(0, Math.floor(num('POKE_COOLDOWN_MS', 8000))),

    // 白名单群原生 +1：独立于普通聊天的静音/安静时段，不调用模型。
    autoPlusOneEnabled: ['1', 'true'].includes(String(env.AUTO_PLUS_ONE_ENABLED ?? '0').trim().toLowerCase()),

    // 盯人回复：定期检查某群里指定用户是否发过言，有则 @ 他回一两句
    targetWatchEnabled: String(env.TARGET_WATCH_ENABLED ?? '0').toLowerCase() !== '0' && String(env.TARGET_WATCH_ENABLED ?? '0').toLowerCase() !== 'false',
    targetWatchGroup: String(env.TARGET_WATCH_GROUP ?? '').trim(),
    targetWatchUser: String(env.TARGET_WATCH_USER ?? '').trim(),
    targetWatchIntervalMs: Math.max(5000, Math.min(600000, Math.floor(num('TARGET_WATCH_INTERVAL_MS', 15000)))),

    // 定时指令：每天定点到指定群 @ 某个账号并发固定内容
    // （例：每天 00:00 在示例群 A @示例机器人(200000015) 发「/今日猪猪」，触发对方的机器人）
    dailyPingEnabled: String(env.DAILY_PING_ENABLED ?? '0').toLowerCase() !== '0' && String(env.DAILY_PING_ENABLED ?? '0').toLowerCase() !== 'false',
    dailyPingTime: String(env.DAILY_PING_TIME ?? '00:00').trim(),
    dailyPingGroup: String(env.DAILY_PING_GROUP ?? '').trim(),
    dailyPingTarget: String(env.DAILY_PING_TARGET ?? '').trim(),
    dailyPingText: String(env.DAILY_PING_TEXT ?? '').trim(),
    // 链式指令：主指令发出后，若目标账号"成功回应"，再补发一条
    // （例：@示例机器人 /今日猪猪 → 它抓到猪猪 → 再 @它 /我的猪圈）
    dailyPingChainEnabled: String(env.DAILY_PING_CHAIN_ENABLED ?? '1').toLowerCase() !== '0' && String(env.DAILY_PING_CHAIN_ENABLED ?? '1').toLowerCase() !== 'false',
    dailyPingChainText: String(env.DAILY_PING_CHAIN_TEXT ?? '').trim(),
    dailyPingChainWindowMs: Math.max(10000, Math.floor(num('DAILY_PING_CHAIN_WINDOW_MS', 90000))),
    dailyPingChainMatch: String(env.DAILY_PING_CHAIN_MATCH ?? '抓到.*猪猪').trim(),

    // 群名片核对（/id_check）：在这些群里，@机器人 发 /id_check 会拉全群名单，
    // 把群名片不符合「房间号＋名字」格式的人 @ 出来提醒改名（房间号和名字之间不需要空格）
    idCheckEnabled: String(env.ID_CHECK_ENABLED ?? '1').toLowerCase() !== '0' && String(env.ID_CHECK_ENABLED ?? '1').toLowerCase() !== 'false',
    idCheckGroups: String(env.ID_CHECK_GROUPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
    idCheckReminder: String(
      env.ID_CHECK_REMINDER ?? localProfile.idCheckReminder ?? '请按本群要求修改群名片，例如「编号 昵称」。'
    ).trim(),
    // 谁能触发 /id_check（QQ 号，逗号分隔）；留空 = 谁都能触发
    // 管理员（最高权限）：能用 /群总结、/帮助、/id_check 等特权指令的 QQ 号，逗号分隔。
    // 留空 = 不限制（沿旧行为，仅建议单人自用时这样；启动日志会提示）。
    adminUsers: String(env.ADMIN_USERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    idCheckOperators: String(env.ID_CHECK_OPERATORS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // 每条消息最多 @ 几个人；0 = 不拆分（所有人一次性 @ 在同一条消息里，默认）
    idCheckPerMessage: Math.max(0, Math.floor(num('ID_CHECK_PER_MESSAGE', 0))),
    idCheckSkipBots: String(env.ID_CHECK_SKIP_BOTS ?? '1').toLowerCase() !== '0' && String(env.ID_CHECK_SKIP_BOTS ?? '1').toLowerCase() !== 'false',
    idCheckSkip: String(env.ID_CHECK_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // 踢人指令（/id_check_kick）：把上一次 /id_check 的结果落地执行
    idCheckKickEnabled:
      String(env.ID_CHECK_KICK_ENABLED ?? '1').toLowerCase() !== '0' &&
      String(env.ID_CHECK_KICK_ENABLED ?? '1').toLowerCase() !== 'false',
    // 核对结果的有效期（超过就不认了，默认 5 分钟）
    idCheckKickWindowMs: Math.max(30000, Math.floor(num('ID_CHECK_KICK_WINDOW_MS', 300000))),
    // 每次踢人之间的间隔，别一口气猛踢触发风控
    idCheckKickGapMs: Math.max(300, Math.floor(num('ID_CHECK_KICK_GAP_MS', 800))),

    // 拟人化与反检测
    emojiKeepRate: Math.min(1, Math.max(0, num('EMOJI_KEEP_RATE', 0.2))),
    humanDelayMinMs: Math.max(0, Math.floor(num('HUMAN_DELAY_MIN_MS', 600))),
    humanDelayMaxMs: Math.max(0, Math.floor(num('HUMAN_DELAY_MAX_MS', 2500))),
    rateLimitPerHour: Math.max(0, Math.floor(num('RATE_LIMIT_PER_HOUR', 25))),
    // "被@必回 / 私聊"这类不能丢的消息用更高的额度（同一个计数桶、阈值更高）：
    // 否则盯人回复会把额度刷满，@ 消息就被当成超额度丢弃，表现为"有概率不回@"
    rateLimitAtPerHour: Math.max(0, Math.floor(num('RATE_LIMIT_AT_PER_HOUR', 45))),
    rateLimitMinGapMs: Math.max(0, Math.floor(num('RATE_LIMIT_MIN_GAP_MS', 4000))),
    // 两条消息间隔不够时，最多等这么久再发（超过就放弃这条）——等一等是为了拟人，丢消息才是事故
    rateLimitWaitMaxMs: Math.max(0, Math.floor(num('RATE_LIMIT_WAIT_MAX_MS', 8000))),
    quietHours: String(env.QUIET_HOURS ?? '').trim(),
    // 安静时段是否"彻底静音"（默认是）：连被 @ 和私聊都不回。
    // 为什么默认开：真人睡着时不回任何消息，"凌晨被@就秒回"是很容易被看出的机器人特征。
    // 设 0 则退回旧行为：安静时段只是不主动搭话，被 @ 仍回。
    quietHoursBlockAll:
      String(env.QUIET_HOURS_BLOCK_ALL ?? '1').toLowerCase() !== '0' &&
      String(env.QUIET_HOURS_BLOCK_ALL ?? '1').toLowerCase() !== 'false',

    // 回复长度自适应与多行回复（长度跟着对方走；以一行为主，偶尔 2~3 行，逐行分条发送）
    replyLengthMatch: String(env.REPLY_LENGTH_MATCH ?? '1').toLowerCase() !== '0' && String(env.REPLY_LENGTH_MATCH ?? '1').toLowerCase() !== 'false',
    replyMaxLines: Math.max(1, Math.min(5, Math.floor(num('REPLY_MAX_LINES', 3)))),
    replyLineMaxChars: Math.max(10, Math.min(200, Math.floor(num('REPLY_LINE_MAX_CHARS', 40)))),
    // 分条发送之间的间隔（比首次"打字"短：第二条是想接着说的，不该等太久）
    lineGapMinMs: Math.max(0, Math.floor(num('LINE_GAP_MIN_MS', 500))),
    lineGapMaxMs: Math.max(0, Math.floor(num('LINE_GAP_MAX_MS', 1600))),
    historyLimit: Math.max(4, Math.min(200, Math.floor(num('HISTORY_LIMIT', 20)))),
    // 上下文记忆：是否把"机器人没回复"的消息也记入上下文（让它像真人一样在场）
    contextRememberAll: String(env.CONTEXT_REMEMBER_ALL ?? '1').toLowerCase() !== '0' && String(env.CONTEXT_REMEMBER_ALL ?? '1').toLowerCase() !== 'false',
    // 长期记忆：被挤出近期窗口的旧消息压缩成摘要（可持续累积，记住远超窗口的内容）
    longMemoryEnabled: String(env.LONG_MEMORY_ENABLED ?? '1').toLowerCase() !== '0' && String(env.LONG_MEMORY_ENABLED ?? '1').toLowerCase() !== 'false',
    longMemoryMaxChars: Math.max(300, Math.min(6000, Math.floor(num('LONG_MEMORY_MAX_CHARS', 1500)))),
    longMemoryIntervalMs: Math.max(60000, Math.floor(num('LONG_MEMORY_INTERVAL_MS', 600000))),

    temperature: Math.min(2, Math.max(0, num('TEMPERATURE', 1.2))),
    maxTokens: Math.max(1, Math.floor(num('MAX_TOKENS', 500))),
    timeoutMs: Math.max(5000, Math.floor(num('TIMEOUT_MS', 90000))),
    maxRetries: Math.max(0, Math.min(5, Math.floor(num('MAX_RETRIES', 2)))),
    maxConcurrency: Math.max(1, Math.min(8, Math.floor(num('MAX_CONCURRENCY', 2)))),

    logLevel: String(env.LOG_LEVEL ?? 'info').toLowerCase(),
  }
}
