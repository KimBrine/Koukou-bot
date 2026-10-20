import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyToGroupId, keyToUserId } from '../chatSettings.js'
import { activatePersona } from '../personaSwitch.js'
import { applyConversationSettings, resetConversationMemory } from '../conversationSessions.js'
import { writeTextAtomic } from '../stateFile.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_FILE = path.join(__dirname, 'ui.html')

/**
 * 机器人控制台：一个只监听 127.0.0.1 的本地服务，界面由 Edge/Chrome 的 app 模式窗口打开。
 *
 * 为什么不做 Electron：本项目零依赖，Electron 要下 200+MB 且得常驻第二个进程；
 * 而"机器人进程自己托管界面"意味着机器人一启动控制台就在，关了窗口也不影响机器人。
 */

// 可以在界面上改的全局配置。live=true 表示改完立刻生效（代码每次用到时才读 config）
const EDITABLE = [
  { key: 'WHITELIST_GROUPS', label: '白名单群', hint: '逗号分隔；只有这些群会被主动搭话', live: true, type: 'text' },
  {
    key: 'MUTED_GROUPS',
    label: '静音群',
    hint: '停止普通聊天，连被 @ 也不回；拍一拍、自动 +1 单独控制',
    live: true,
    type: 'text',
    wide: true,
  },
  { key: 'ADMIN_USERS', label: '管理员 QQ', hint: '管理员 QQ 号，逗号分隔。留空时群总结等沿用公开范围；QQ 清除记忆指令必须显式配置管理员。id_check 同时遵守对应群与操作员规则。', live: true, type: 'text', wide: true },
  { key: 'PROACTIVE_RATE', label: '全局主动搭话概率', hint: '未单独配置的群使用这个百分比', live: true, type: 'rate' },
  { key: 'PROACTIVE_RATE_PER_GROUP', label: '按群独立概率', hint: '给指定群设置默认概率；移除后沿用全局。会话单独设置优先。', live: true, type: 'text', wide: true },
  { key: 'PROACTIVE_COOLDOWN_MS', label: '主动搭话冷却(ms)', hint: '同一个群两条主动消息的最小间隔', live: true, type: 'number' },
  { key: 'QUIET_GREETINGS_ENABLED', label: '白名单群早晚安', hint: '按各群安静时段与人格固定语库随机发送，不调用AI；晚安只在开始边界触发，早安在结束后首次确认在线时触发。遵守会话总开关与静音名单。', live: false, type: 'bool' },
  { key: 'QUIET_HOURS', label: '安静时段', hint: '如 01:00-07:00；留空=不启用。默认停止普通聊天（连被@也不回）；拍一拍、自动 +1 单独控制', live: true, type: 'text' },
  {
    key: 'QUIET_HOURS_BLOCK_ALL',
    label: '安静时段彻底静音',
    hint: '1=连被@和私聊都不回（默认，像真人睡着） 0=只不主动搭话，被@仍回',
    live: true,
    type: 'bool',
  },
  { key: 'EMOJI_KEEP_RATE', label: '装饰符号频率', hint: '表情与颜文字出现在多少比例的回复里；种类由人格或私有偏好决定', live: true, type: 'rate' },
  { key: 'HUMAN_DELAY_MIN_MS', label: '打字延迟下限(ms)', live: true, type: 'number' },
  { key: 'HUMAN_DELAY_MAX_MS', label: '打字延迟上限(ms)', live: true, type: 'number' },
  { key: 'REPLY_LENGTH_MATCH', label: '回复长度自适应', hint: '1=跟着对方长度走 0=固定单行', live: true, type: 'bool' },
  { key: 'REPLY_MAX_LINES', label: '最多分几行', live: true, type: 'number' },
  { key: 'REPLY_LINE_MAX_CHARS', label: '单行字数上限', live: true, type: 'number' },
  { key: 'LINE_GAP_MIN_MS', label: '分条间隔下限(ms)', live: true, type: 'number' },
  { key: 'LINE_GAP_MAX_MS', label: '分条间隔上限(ms)', live: true, type: 'number' },
  { key: 'RATE_LIMIT_PER_HOUR', label: '每小时发言上限(主动/盯人)', hint: '防止刷屏特征', live: false, type: 'number' },
  { key: 'RATE_LIMIT_AT_PER_HOUR', label: '每小时发言上限(@/引用/私聊)', hint: '直接对话用更高额度，避免被主动搭话或盯人挤掉', live: false, type: 'number' },
  { key: 'RATE_LIMIT_MIN_GAP_MS', label: '两条消息最小间隔(ms)', hint: '间隔不够时会等一会儿再发，不会丢消息', live: false, type: 'number' },
  { key: 'RATE_LIMIT_WAIT_MAX_MS', label: '为凑间隔最多等多久(ms)', hint: '超过这个时长还轮不到就放弃这条（防刷屏洪水）', live: true, type: 'number' },
  { key: 'HISTORY_LIMIT', label: '上下文窗口(条)', live: false, type: 'number' },
  { key: 'CONTEXT_REMEMBER_ALL', label: '记住未回复的消息', live: true, type: 'bool' },
  { key: 'POKE_REPLY_ENABLED', label: '拍一拍回应', live: true, type: 'bool' },
  { key: 'AUTO_PLUS_ONE_ENABLED', label: '自动 +1', hint: '仅白名单群：群友连续两条相同文字消息后跟一次，可夹QQ自带表情，文字及表情顺序须一致。图片、图片表情包及纯QQ表情不跟读。同一连续段只跟一次，机器人自己的消息不计数。不调用模型，独立于普通聊天开关、静音和安静时段。', live: true, type: 'bool' },
  { key: 'TARGET_WATCH_ENABLED', label: '盯人回复', live: false, type: 'bool' },
  { key: 'TARGET_WATCH_GROUP', label: '盯人目标群', live: false, type: 'text' },
  { key: 'TARGET_WATCH_USER', label: '盯人目标QQ', live: false, type: 'text' },
  { key: 'TARGET_WATCH_INTERVAL_MS', label: '盯人检查间隔(ms)', live: false, type: 'number' },
  { key: 'SUMMARY_ENABLED', label: '每日报告', live: false, type: 'bool' },
  { key: 'SUMMARY_FALLBACK_ENABLED', label: '23:30 漏发补发', hint: '23:00 未发过报告的群，23:30 核验 QQ 在线与发送历史后补一次；已发、仍在生成或无法确认时跳过。两个时点都未登录则当晚放弃，恢复登录不追补。', live: false, type: 'bool' },
  { key: 'SUMMARY_TIMES', label: '报告时间', hint: 'HH:mm，逗号分隔可多个', live: false, type: 'text' },
  { key: 'SUMMARY_GROUPS', label: '报告目标群', hint: '留空=用白名单群', live: false, type: 'text' },
  { key: 'SUMMARY_SEND_MODE', label: '报告发送方式', hint: '先按空行分段；forward=合并转发卡片，split=逐段发送', live: false, type: 'text' },
  { key: 'SUMMARY_UNRESTRICTED', label: '群总结宽裕模式', hint: '开启后使用完整主聊天记录，不设置本地输出token、固定话题数量或整份总结总时限；单次请求仍有故障等待检测。下面的消息条数、输出token和准备时限暂不生效；模型服务商自身容量与网络限制仍然存在。', live: false, type: 'bool' },
  { key: 'SUMMARY_REQUEST_TIMEOUT_SECONDS', label: '单次模型等待（秒）', hint: '宽裕模式使用，60～3600，默认900（15分钟）。每次尝试分别计时，超时有限重试；整份总结无总时限。非流式接口无法区分正常思考和连接卡住，可按需加大。', live: false, type: 'number' },
  { key: 'SUMMARY_BOT_USERS', label: '已知机器人 QQ（选题降权）', hint: '逗号分隔。机器人的播报不算真人讨论；原始消息统计保持完整。默认不预置账号。', live: false, type: 'text' },
  { key: 'SUMMARY_MAX_MESSAGES', label: '报告消息条数上限', live: false, type: 'number' },
  { key: 'SUMMARY_MAX_TOKENS', label: '总结输出 token 上限', hint: '500～16000；控制总结篇幅，与普通聊天的输出上限分开设置', live: false, type: 'number' },
  { key: 'SUMMARY_CONCURRENCY', label: '同时生成的群数', hint: '1～3，默认 2；慢群不会阻塞全部后续群。报告发送仍串行，群间至少间隔 5 秒。', live: false, type: 'number' },
  { key: 'SUMMARY_TASK_TIMEOUT_MINUTES', label: '单群准备时限（分钟）', hint: '2～30，默认 6；历史拉取、模型排队、生成与修正共用此时限，超时取消本群，其他群继续。', live: false, type: 'number' },
  { key: 'SUMMARY_PROVIDER', label: '报告模型服务商', hint: '只影响群聊报告，不影响图片识别', live: false, type: 'text' },
  { key: 'SUMMARY_MODEL', label: '报告模型', hint: '群聊总结使用的模型，与视觉模型独立', live: false, type: 'text' },
  { key: 'SUMMARY_VISION_MODEL', label: '转发参考图片模型（通义千问）', hint: '仅用于群总结展开记录里的图片；默认沿用 DashScope 型号，与普通聊天识图独立', live: false, type: 'text' },
  { key: 'SUMMARY_REFERENCE_MAX_IMAGES', label: '每份总结最多读取的参考图片', hint: '先筛选相关记录再读图；0～12，默认6；0只展开文字。图片与内层消息不增加统计或话题权重', live: false, type: 'number' },
  { key: 'DASHSCOPE_ENABLE_THINKING', label: '千问辅助模型思考模式', hint: '支持混合思考的千问报告、记忆整理和备用识图模型使用；默认关闭以减少长报告等待时间。', live: false, type: 'bool' },
  { key: 'DAILY_PING_ENABLED', label: '定时指令', hint: '每天定点到群里 @ 某个账号发固定内容', live: false, type: 'bool' },
  { key: 'DAILY_PING_TIME', label: '定时指令时间', hint: 'HH:mm；00:00 会在 00:00:10 发送，留出跨日缓冲', live: false, type: 'text' },
  { key: 'DAILY_PING_GROUP', label: '定时指令目标群', live: false, type: 'text' },
  { key: 'DAILY_PING_TARGET', label: '定时指令 @ 谁', live: false, type: 'text' },
  { key: 'DAILY_PING_TEXT', label: '定时指令内容', hint: '以「@某人 + 空格 + 内容」发出', live: false, type: 'text' },
  { key: 'DAILY_PING_CHAIN_ENABLED', label: '链式补发', hint: '对方成功回应后再补发一条', live: true, type: 'bool' },
  { key: 'DAILY_PING_CHAIN_MATCH', label: '链式：成功判据(正则)', hint: '匹配对方回复内容，例：抓到.*猪猪', live: true, type: 'text', wide: true },
  { key: 'DAILY_PING_CHAIN_TEXT', label: '链式：补发内容', hint: '例：/我的猪圈', live: true, type: 'text' },
  { key: 'DAILY_PING_CHAIN_WINDOW_MS', label: '链式：等待窗口(ms)', live: true, type: 'number' },
  { key: 'DEEPSEEK_MODEL', label: '对话模型', live: false, type: 'text' },
  { key: 'DEEPSEEK_REASONING_EFFORT', label: 'DeepSeek 思考强度', hint: '统一用于 DeepSeek 对话、指令理解与识图；DeepSeek 总结也沿用此项。千问独立设置。max 可能增加等待与消耗；不会增加会话记忆长度。留空沿用服务端默认。', live: false, type: 'text' },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek Key', live: false, type: 'secret' },
  { key: 'VISION_PROVIDER', label: '识图服务商', hint: '当前选用哪家服务识别图片', live: false, type: 'text' },
  { key: 'VISION_MODEL', label: 'DeepSeek 识图模型', hint: '识图服务商为 DeepSeek 时使用', live: false, type: 'text' },
  { key: 'DASHSCOPE_MODEL', label: 'DashScope 识图模型', hint: '仅识图服务商为 DashScope 时使用；不代表当前生效模型', live: false, type: 'text' },
  { key: 'DASHSCOPE_API_KEY', label: 'DashScope Key', live: false, type: 'secret' },
  { key: 'BAIDU_QIANFAN_API_KEY', label: '百度千帆 Key', live: false, type: 'secret' },
  { key: 'TEMPERATURE', label: '采样温度', hint: '越高越随性', live: false, type: 'number' },
  { key: 'MAX_TOKENS', label: '单次回复 token 上限', live: false, type: 'number' },
  { key: 'LOG_LEVEL', label: '日志级别', hint: 'debug/info/warn/error', live: false, type: 'text' },
]

function readEnvFile(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** 只改指定 key 的值，保留 .env 里的注释与顺序；没有的追加到末尾 */
function writeEnvFile(file, patch, { atomic = false } = {}) {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  for (const [key, value] of Object.entries(patch)) {
    const re = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`, 'm')
    if (re.test(text)) text = text.replace(re, (_, prefix) => prefix + value)
    else text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${key}=${value}\n`
  }
  if (atomic) writeTextAtomic(file, text)
  else writeFileSync(file, text)
}

function tailFile(file, lineCount, filter = '') {
  try {
    if (!existsSync(file)) return []
    const size = statSync(file).size
    const readBytes = Math.min(size, 512 * 1024)
    const fd = readFileSync(file)
    const text = fd.slice(Math.max(0, fd.length - readBytes)).toString('utf8')
    let lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length > 1 && size > readBytes) lines = lines.slice(1) // 丢弃可能被截断的首行
    if (filter) {
      const f = filter.toLowerCase()
      lines = lines.filter((l) => l.toLowerCase().includes(f))
    }
    return lines.slice(-lineCount)
  } catch {
    return []
  }
}

function testPort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function validateGroupConfig(key, value) {
  if (key === 'WHITELIST_GROUPS') {
    if (value.trim() && value.split(',').some(id => !/^\d{5,12}$/.test(id.trim()))) throw new Error('群号应为 5～12 位数字')
  }
  if (key === 'PROACTIVE_RATE_PER_GROUP') {
    const seen = new Set()
    for (const piece of value.trim() ? value.split(',') : []) {
      const match = /^(\d{5,12}):([0-9]+(?:\.[0-9]+)?)$/.exec(piece.trim())
      if (!match || Number(match[2]) > 1) throw new Error('群概率需要有效群号和 0～100% 的概率')
      const id = Number(match[1])
      if (seen.has(id)) throw new Error('同一个群只能设置一项概率')
      seen.add(id)
    }
  }
}

export function createAdminServer({ config, logger, onebot, memory, chatSettings, dailySummary, targetWatch, longMemory, runtimeStats, dailyPing, quietGreetings, personaGreetings, bot, customCommands, commandCenter, restartBot }) {
  // 本实例自己的 .env（并行跑两个实例时，写死 rootDir\.env 会改到另一个实例的配置上）
  const envFile = config.envFile || path.join(config.rootDir, '.env')
  const logFile = path.join(config.logDir || path.join(config.rootDir, 'logs'), 'bot.log')
  const personaDir = config.personaDir || path.join(config.dataDir, 'personas')
  const dailyDir = path.join(config.dataDir, 'daily')

  let groupListCache = { at: 0, items: [] }
  let friendListCache = { at: 0, items: [] }

  async function getGroupList() {
    if (Date.now() - groupListCache.at < 30000) return groupListCache.items
    try {
      const res = await onebot.api('get_group_list', {}, 6000)
      const items = (Array.isArray(res) ? res : res?.data ?? []).map((g) => ({
        id: String(g.group_id),
        name: g.group_name || String(g.group_id),
        members: g.member_count ?? null,
      }))
      groupListCache = { at: Date.now(), items }
    } catch (err) {
      logger?.debug?.(`控制台拉取群列表失败：${err.message}`)
    }
    return groupListCache.items
  }

  async function getFriendList() {
    if (Date.now() - friendListCache.at < 60000) return friendListCache.items
    try {
      const res = await onebot.api('get_friend_list', {}, 6000)
      const items = (Array.isArray(res) ? res : res?.data ?? []).map((f) => ({
        id: String(f.user_id),
        name: f.nickname || f.remark || String(f.user_id),
      }))
      friendListCache = { at: Date.now(), items }
    } catch (err) {
      logger?.debug?.(`控制台拉取好友列表失败：${err.message}`)
    }
    return friendListCache.items
  }

  /** 会话列表：来自记忆 + 白名单 + 日报数据，尽量补上名字与今日消息数 */
  async function buildChatList() {
    const mem = readJsonSafe(config.memoryFile, {})
    const keys = new Set([...Object.keys(mem), ...chatSettings.keys()])
    for (const g of config.whitelistGroups) keys.add(`g${g}`)

    const groups = await getGroupList()
    const friends = await getFriendList()
    const groupMap = new Map(groups.map((g) => [g.id, g]))
    const friendMap = new Map(friends.map((f) => [f.id, f]))
    const today = new Date()
    const pad2 = (n) => String(n).padStart(2, '0')
    const dateKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`

    const out = []
    for (const key of keys) {
      const gid = keyToGroupId(key)
      const uid = keyToUserId(key)
      if (gid === null && uid === null) continue
      const raw = chatSettings.raw(key)
      const eff = chatSettings.resolve(key, config)
      let name = ''
      let members = null
      let msgToday = 0
      if (gid !== null) {
        const g = groupMap.get(String(gid))
        name = g?.name ?? ''
        members = g?.members ?? null
        const file = path.join(dailyDir, String(gid), `${dateKey}.jsonl`)
        if (existsSync(file)) {
          msgToday = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length
        }
      } else {
        name = friendMap.get(String(uid))?.name ?? ''
      }
      const history = Array.isArray(mem[key]) ? mem[key] : []
      const lastLine = history.length > 0 ? history[history.length - 1] : null
      out.push({
        key,
        type: gid !== null ? 'group' : 'private',
        id: gid ?? uid,
        name: name || (raw?.note ?? '') || (gid !== null ? `群 ${gid}` : `QQ ${uid}`),
        members,
        inWhitelist: gid !== null && config.whitelistGroups.has(gid),
        msgToday,
        memory: history.length,
        lastActive: runtimeStats?.lastMessage?.get?.(key) ?? null,
        replies: runtimeStats?.replies?.get?.(key) ?? 0,
        received: runtimeStats?.received?.get?.(key) ?? 0,
        raw: raw ?? {},
        persona: raw?.persona || '',
        effective: eff,
      })
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'group' ? -1 : 1
      return b.msgToday - a.msgToday || b.memory - a.memory
    })
    return out
  }

  function listPersonas() {
    mkdirSync(personaDir, { recursive: true })
    const active = String(config.activePersona || '')
    return readdirSync(personaDir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => {
        const full = path.join(personaDir, f)
        const st = statSync(full)
        return { name: f.replace(/\.txt$/, ''), size: st.size, mtime: st.mtimeMs, active: f.replace(/\.txt$/, '') === active }
      })
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
  }

  function personaPath(name) {
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    return path.join(personaDir, `${safe}.txt`)
  }

  function todayStats() {
    const pad2 = (n) => String(n).padStart(2, '0')
    const d = new Date()
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    const perGroup = []
    let total = 0
    try {
      if (existsSync(dailyDir)) {
        for (const gid of readdirSync(dailyDir)) {
          const file = path.join(dailyDir, gid, `${key}.jsonl`)
          if (!existsSync(file)) continue
          const n = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length
          perGroup.push({ groupId: gid, count: n })
          total += n
        }
      }
    } catch {
      /* ignore */
    }
    perGroup.sort((a, b) => b.count - a.count)
    return { date: key, total, perGroup }
  }

  async function buildState() {
    const health = await onebot?.refreshStatus?.() ?? onebot?.status?.() ?? {}
    const wsOpen = health.connected ?? false
    let onebotPort = 3001
    try { onebotPort = Number(new URL(config.onebotWsUrl).port) || onebotPort } catch { /* use default */ }
    const portOk = await testPort(onebotPort)
    const replyStats = {}
    if (runtimeStats?.replies) for (const [k, v] of runtimeStats.replies) replyStats[k] = v
    return {
      now: Date.now(),
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - (runtimeStats?.startedAt ?? Date.now())) / 1000),
      bot: {
        // connected 兼容旧版界面：只有已确认 QQ 在线才亮绿灯。
        connected: health.online === true,
        online: health.online === true,
        onebotConnected: wsOpen,
        qqOnline: health.qqOnline ?? null,
        qqGood: health.qqGood ?? null,
        reportedOnline: health.reportedOnline ?? null,
        probeVerified: health.probeVerified === true,
        probeCheckedAt: health.probeCheckedAt ?? 0,
        statusCheckedAt: health.statusCheckedAt ?? 0,
        statusError: health.statusError ?? '',
        selfId: onebot?.selfId ?? null,
        nickname: onebot?.nickname ?? null,
        model: config.deepseekModel,
        deepseekReasoningEffort: config.deepseekReasoningEffort ?? null,
        // 必须跟着 VISION_PROVIDER 走：只报 dashscopeModel 的话，
        // 明明已经切到 DeepSeek 读图，控制台还显示 qwen，看起来像没生效。
        visionModel: (() => {
          const ds = String(config.visionProvider ?? 'dashscope').toLowerCase() === 'deepseek'
          const key = ds ? config.deepseekApiKey : config.dashscopeApiKey
          if (!key) return null
          return ds ? `${config.visionModel || 'deepseek-flash'}（DeepSeek）` : `${config.dashscopeModel}（DashScope）`
        })(),
        webSearch: Boolean(config.baiduApiKey),
        onebotUrl: config.onebotWsUrl,
        napcatPort: portOk,
        napcatPortNumber: onebotPort,
      },
      today: todayStats(),
      replies: replyStats,
      today_replies: runtimeStats?.todayReplies ?? null,
      counters: {
        received: runtimeStats?.totalReceived ?? 0,
        replied: runtimeStats?.totalReplied ?? 0,
        skipped: runtimeStats?.totalSkipped ?? 0,
      },
      config: {
        whitelist: [...config.whitelistGroups],
        proactiveRate: config.proactiveRate,
        proactiveRatePerGroup: [...(config.proactiveRatePerGroup ?? new Map())].map(([g, r]) => ({ groupId: g, rate: r })),
        emojiKeepRate: config.emojiKeepRate,
        quietHours: config.quietHours,
        quietGreetings: quietGreetings?.status?.() ?? {enabled:false,groups:[]},
        replyMaxLines: config.replyMaxLines,
        lineMaxChars: config.replyLineMaxChars,
        activePersona: config.activePersona || '',
        adminUsers: [...(config.adminUsers || [])],
        summaryTimes: config.summaryTimes,
        summaryFallbackEnabled: config.summaryFallbackEnabled,
        summaryGroups: config.summaryGroups,
        summaryUnrestricted: Boolean(config.summaryUnrestricted),
        summaryRequestTimeoutSeconds: config.summaryRequestTimeoutSeconds ?? 900,
        summaryActiveLimits: {maxMessages:config.summaryUnrestricted?null:config.summaryMaxMessages,maxOutputTokens:config.summaryUnrestricted?null:config.summaryMaxTokens,taskTimeoutMinutes:config.summaryUnrestricted?null:config.summaryTaskTimeoutMinutes},
        targetWatch: targetWatch?.enabled ? { group: targetWatch.groupId, user: targetWatch.userId, pending: targetWatch.pendingCount?.() ?? 0 } : null,
      },
    }
  }

  const routes = {
    'GET /api/state': async () => buildState(),
    'GET /api/chats': async () => ({ items: await buildChatList() }),
    'GET /api/groups': async () => ({ items: await getGroupList() }),
    'GET /api/custom-commands': async () => ({ items: typeof customCommands?.all === 'function' ? customCommands.all() : [],builtinItems:commandCenter?.all()||[],poke:commandCenter?.diagnostics()||{} }),
    'GET /api/personas': async () => ({ items: listPersonas(), active: config.activePersona || '', dir: personaDir }),
    'GET /api/memory-overview': async () => {
      const map = new Map()
      const recentKeys = typeof memory?.keys === 'function' ? memory.keys() : []
      for (const k of recentKeys) {
        map.set(k, { key: k, recent: typeof memory?.count === 'function' ? memory.count(k) : 0, longTermChars: 0, pending: 0 })
      }
      const longs = typeof longMemory?.stats === 'function' ? longMemory.stats() : []
      for (const item of longs) {
        const cur = map.get(item.key) || { key: item.key, recent: 0, longTermChars: 0, pending: 0 }
        cur.longTermChars = item.summaryChars || 0
        cur.pending = item.pending || 0
        map.set(item.key, cur)
      }
      for (const k of chatSettings.keys()) if (!map.has(k)) map.set(k, { key: k, recent: 0, longTermChars: 0, pending: 0 })
      const items = [...map.values()].sort((a, b) => b.recent + b.longTermChars - (a.recent + a.longTermChars))
      return { persona: config.activePersona || '', items }
    },
    'GET /api/config': async () => {
      const env = readEnvFile(envFile)
      return {
        items: EDITABLE.map((f) => ({
          ...f,
          value: f.type === 'secret' ? '' : String(env[f.key] ?? ''),
          effective: f.type === 'secret' ? '' : fieldEffective(f.key),
          configured: f.type === 'secret' ? Boolean(env[f.key]) : undefined,
        })),
      }
    },
    'GET /api/logs': async (query) => {
      const lines = Math.min(1000, Number(query.lines) || 200)
      return {
        bot: tailFile(logFile, lines, query.filter || ''),
      }
    },
    'GET /api/memory': async (query) => {
      const mem = readJsonSafe(config.memoryFile, {})
      const key = String(query.key || '')
      const list = Array.isArray(mem[key]) ? mem[key] : []
      return { key, items: list.slice(-200) }
    },
    'GET /api/longmemory': async (query) => ({
      key: query.key || null,
      text: longMemory?.get?.(String(query.key || ''), { query: String(query.q || '').slice(0, 500) }) ?? '',
    }),
    'GET /api/daily': async () => {
      const out = []
      try {
        if (existsSync(dailyDir)) {
          for (const gid of readdirSync(dailyDir)) {
            const dir = path.join(dailyDir, gid)
            const files = readdirSync(dir)
              .filter((f) => f.endsWith('.jsonl'))
              .sort()
              .reverse()
              .slice(0, 14)
            for (const f of files) {
              const st = statSync(path.join(dir, f))
              out.push({ groupId: gid, date: f.replace(/\.jsonl$/, ''), size: st.size })
            }
          }
        }
      } catch {
        /* ignore */
      }
      return { items: out }
    },
  }

  function fieldEffective(key) {
    if (key === 'QUIET_GREETINGS_ENABLED') return config.quietGreetingsEnabled?'1':'0'
    if (key === 'DEEPSEEK_REASONING_EFFORT') return config.deepseekReasoningEffort ?? ''
    const cur = readEnvFile(envFile)[key]
    const map = {
      WHITELIST_GROUPS: () => [...config.whitelistGroups].join(','),
      MUTED_GROUPS: () => [...(config.mutedGroups ?? new Set())].join(','),
      PROACTIVE_RATE: () => String(config.proactiveRate),
      PROACTIVE_RATE_PER_GROUP: () => [...(config.proactiveRatePerGroup ?? new Map())].map(([g, r]) => `${g}:${r}`).join(','),
      VISION_PROVIDER: () => String(config.visionProvider),
      VISION_MODEL: () => String(config.visionModel),
      DASHSCOPE_MODEL: () => String(config.dashscopeModel),
      SUMMARY_PROVIDER: () => String(config.summaryProvider),
      SUMMARY_MODEL: () => String(config.summaryModel),
      SUMMARY_BOT_USERS: () => (config.summaryBotUsers||[]).join(','),
      SUMMARY_UNRESTRICTED: () => config.summaryUnrestricted?'1':'0',
      SUMMARY_REQUEST_TIMEOUT_SECONDS: () => String(config.summaryRequestTimeoutSeconds ?? 900),
      SUMMARY_VISION_MODEL: () => String(config.summaryVisionModel),
      SUMMARY_REFERENCE_MAX_IMAGES: () => String(config.summaryReferenceMaxImages),
      SUMMARY_CONCURRENCY: () => String(config.summaryConcurrency),
      SUMMARY_TASK_TIMEOUT_MINUTES: () => String(config.summaryTaskTimeoutMinutes),
      DASHSCOPE_ENABLE_THINKING: () => config.dashscopeThinking ? '1' : '0',
      SUMMARY_FALLBACK_ENABLED: () => (config.summaryFallbackEnabled ? '1' : '0'),
      EMOJI_KEEP_RATE: () => String(config.emojiKeepRate),
      QUIET_HOURS: () => String(config.quietHours ?? ''),
      REPLY_MAX_LINES: () => String(config.replyMaxLines),
      REPLY_LINE_MAX_CHARS: () => String(config.replyLineMaxChars),
      HUMAN_DELAY_MIN_MS: () => String(config.humanDelayMinMs),
      HUMAN_DELAY_MAX_MS: () => String(config.humanDelayMaxMs),
      LINE_GAP_MIN_MS: () => String(config.lineGapMinMs),
      LINE_GAP_MAX_MS: () => String(config.lineGapMaxMs),
      PROACTIVE_COOLDOWN_MS: () => String(config.proactiveCooldownMs),
      CONTEXT_REMEMBER_ALL: () => (config.contextRememberAll ? '1' : '0'),
      REPLY_LENGTH_MATCH: () => (config.replyLengthMatch ? '1' : '0'),
      POKE_REPLY_ENABLED: () => ((commandCenter ? commandCenter.enabled('poke') : config.pokeEnabled) ? '1' : '0'),
      AUTO_PLUS_ONE_ENABLED: () => ((commandCenter ? commandCenter.enabled('auto-plus-one') : config.autoPlusOneEnabled) ? '1' : '0'),
      DAILY_PING_CHAIN_ENABLED: () => (config.dailyPingChainEnabled ? '1' : '0'),
      DAILY_PING_CHAIN_MATCH: () => String(config.dailyPingChainMatch ?? ''),
      DAILY_PING_CHAIN_TEXT: () => String(config.dailyPingChainText ?? ''),
      DAILY_PING_CHAIN_WINDOW_MS: () => String(config.dailyPingChainWindowMs ?? ''),
    }
    const fn = map[key]
    return fn ? fn() : (cur ?? '')
  }

  /** 界面改完立刻生效：直接改内存里的 config（代码用到时才读，所以不需要重启） */
  function applyLive(key, value) {
    const bool = (v) => v === '1' || String(v).toLowerCase() === 'true'
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
    switch (key) {
      case 'WHITELIST_GROUPS':
        config.whitelistGroups = new Set(
          String(value)
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0),
        )
        break
      case 'MUTED_GROUPS':
        // 静音群随时可改：迁移时把新号接管的群加进来，旧号立刻闭嘴（反之亦然）
        config.mutedGroups = new Set(
          String(value)
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0),
        )
        break
      case 'ADMIN_USERS':
        config.adminUsers = String(value)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        break
      case 'PROACTIVE_RATE':
        config.proactiveRate = Math.min(1, Math.max(0, num(value, config.proactiveRate)))
        break
      case 'PROACTIVE_RATE_PER_GROUP': {
        const map = new Map()
        for (const piece of String(value).split(',')) {
          const [g, r] = piece.split(':').map((s) => s.trim())
          if (Number.isFinite(Number(g)) && Number(g) > 0 && Number.isFinite(Number(r))) {
            map.set(Number(g), Math.min(1, Math.max(0, Number(r))))
          }
        }
        config.proactiveRatePerGroup = map
        config.proactiveRateFor = (groupId) => (map.has(Number(groupId)) ? map.get(Number(groupId)) : config.proactiveRate)
        break
      }
      case 'PROACTIVE_COOLDOWN_MS':
        config.proactiveCooldownMs = Math.max(0, num(value, config.proactiveCooldownMs))
        break
      case 'QUIET_HOURS':
        config.quietHours = String(value).trim()
        break
      case 'QUIET_HOURS_BLOCK_ALL':
        config.quietHoursBlockAll = bool(value)
        break
      case 'EMOJI_KEEP_RATE':
        config.emojiKeepRate = Math.min(1, Math.max(0, num(value, config.emojiKeepRate)))
        break
      case 'HUMAN_DELAY_MIN_MS':
        config.humanDelayMinMs = Math.max(0, num(value, config.humanDelayMinMs))
        break
      case 'HUMAN_DELAY_MAX_MS':
        config.humanDelayMaxMs = Math.max(0, num(value, config.humanDelayMaxMs))
        break
      case 'LINE_GAP_MIN_MS':
        config.lineGapMinMs = Math.max(0, num(value, config.lineGapMinMs))
        break
      case 'LINE_GAP_MAX_MS':
        config.lineGapMaxMs = Math.max(0, num(value, config.lineGapMaxMs))
        break
      case 'REPLY_MAX_LINES':
        config.replyMaxLines = Math.max(1, Math.min(5, Math.floor(num(value, config.replyMaxLines))))
        break
      case 'REPLY_LINE_MAX_CHARS':
        config.replyLineMaxChars = Math.max(10, Math.min(200, Math.floor(num(value, config.replyLineMaxChars))))
        break
      case 'REPLY_LENGTH_MATCH':
        config.replyLengthMatch = bool(value)
        break
      case 'CONTEXT_REMEMBER_ALL':
        config.contextRememberAll = bool(value)
        break
      case 'POKE_REPLY_ENABLED':
        if(commandCenter)commandCenter.saveBuiltin({...commandCenter.get('poke'),enabled:bool(value)})
        config.pokeEnabled = bool(value)
        break
      case 'AUTO_PLUS_ONE_ENABLED':
        if(commandCenter)commandCenter.saveBuiltin({...commandCenter.get('auto-plus-one'),enabled:bool(value)})
        config.autoPlusOneEnabled = bool(value)
        break
      case 'DAILY_PING_CHAIN_ENABLED':
        config.dailyPingChainEnabled = bool(value)
        break
      case 'DAILY_PING_CHAIN_MATCH':
        config.dailyPingChainMatch = String(value).trim() || '抓到.*猪猪'
        break
      case 'DAILY_PING_CHAIN_TEXT':
        config.dailyPingChainText = String(value).trim()
        break
      case 'DAILY_PING_CHAIN_WINDOW_MS':
        config.dailyPingChainWindowMs = Math.max(10000, num(value, config.dailyPingChainWindowMs))
        break
      default:
        return false
    }
    return true
  }

  const actions = {
    async 'set-config-batch'(payload) {
      const patch = payload?.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch) ? payload.patch : {}
      const entries = Object.entries(patch)
      if (entries.length === 0) return { ok: true, changed: 0, live: 0, needRestart: false }
      if (entries.length > 80) throw new Error('一次修改的配置项过多')
      const clean = {}
      for (const [key, raw] of entries) {
        const field = EDITABLE.find((f) => f.key === key)
        if (!field) throw new Error(`不认识的配置项：${key}`)
        const value = String(raw ?? '')
        if (/[\r\n]/.test(value)) throw new Error(`${field.label} 不能包含换行`)
        validateGroupConfig(key, value)
        if (key === 'DEEPSEEK_REASONING_EFFORT' && !['','none','low','high','max'].includes(value)) throw new Error('DeepSeek 思考强度应为默认、关闭、low、high或max')
        if (field.type === 'rate' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)) {
          throw new Error(`${field.label} 应在 0～1 之间`)
        }
        if (field.type === 'number' && !Number.isFinite(Number(value))) throw new Error(`${field.label} 需要填写数字`)
        if (key === 'SUMMARY_MAX_TOKENS' && (!Number.isInteger(Number(value)) || Number(value) < 500 || Number(value) > 16000)) throw new Error('总结输出 token 上限应为 500～16000 的整数')
        if (key === 'SUMMARY_REQUEST_TIMEOUT_SECONDS' && (!Number.isInteger(Number(value)) || Number(value) < 60 || Number(value) > 3600)) throw new Error('单次模型等待应为60～3600秒的整数')
        if (key === 'SUMMARY_CONCURRENCY' && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 3)) throw new Error('同时生成的群数应为 1～3 的整数')
        if (key === 'SUMMARY_TASK_TIMEOUT_MINUTES' && (!Number.isInteger(Number(value)) || Number(value) < 2 || Number(value) > 30)) throw new Error('单群准备时限应为 2～30 分钟的整数')
        if (key === 'SUMMARY_REFERENCE_MAX_IMAGES' && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 12)) throw new Error('每份总结参考图片上限应为 0～12 的整数')
        if (key === 'SUMMARY_TIMES' && value.split(',').some((v) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim()))) {
          throw new Error('报告时间应为 HH:mm，多个时间用逗号分隔')
        }
        clean[key] = value
      }
      writeEnvFile(envFile, clean)
      let live = 0
      for (const [key, value] of Object.entries(clean)) {
        if (applyLive(key, value)) live++
        logger?.info?.(`[控制台] 修改配置 ${key}=${EDITABLE.find((f) => f.key === key)?.type === 'secret' ? '[已更新]' : value.slice(0, 40)}`)
      }
      return { ok: true, changed: entries.length, live, needRestart: live < entries.length }
    },
    async 'set-config'(payload) {
      const { key, value } = payload
      const field = EDITABLE.find((f) => f.key === key)
      if (!field) throw new Error(`不认识的配置项：${key}`)
      validateGroupConfig(key, String(value ?? ''))
      writeEnvFile(envFile, { [key]: String(value ?? '') })
      const live = applyLive(key, value)
      logger?.info?.(`[控制台] 修改配置 ${key}=${field.type === 'secret' ? '[已更新]' : String(value).slice(0, 40)}${live ? '（已即时生效）' : '（需重启生效）'}`)
      return { ok: true, live, needRestart: !live }
    },
    async 'update-whitelist'(payload) {
      if (!['add', 'remove'].includes(payload.operation)) throw new Error('不支持的白名单操作')
      if (!Array.isArray(payload.groupIds) || !payload.groupIds.length) throw new Error('请选择或输入群号')
      const ids = [...new Set(payload.groupIds.map(id => String(id).trim()))]
      if (ids.some(id => !/^\d{5,12}$/.test(id))) throw new Error('群号应为 5～12 位数字')
      const next = new Set(config.whitelistGroups)
      let changed = 0
      for (const id of ids.map(Number)) {
        if (payload.operation === 'add') {
          if (!next.has(id)) { next.add(id); changed++ }
        } else if (next.delete(id)) changed++
      }
      const value = [...next].join(',')
      writeEnvFile(envFile, { WHITELIST_GROUPS: value })
      applyLive('WHITELIST_GROUPS', value)
      logger?.info?.(`[控制台] ${payload.operation === 'add' ? '添加' : '移出'}白名单群 ${ids.join(',')}`)
      return { ok: true, changed, whitelist: [...next] }
    },
    async 'set-chat'(payload) {
      const { key, patch } = payload
      if (!key) throw new Error('缺少会话 key')
      const change = applyConversationSettings({ config, memory, longMemory, targetWatch, chatSettings, key, patch: patch ?? {} })
      const saved = change.settings
      logger?.info?.(`[控制台] 更新会话设置 ${key}`)
      return { ok: true, settings: saved, memoryReset: change.reset }
    },
    async 'reset-chat'(payload) {
      const key = String(payload.key || '')
      if (chatSettings.get(key).persona) resetConversationMemory({ config, memory, longMemory, targetWatch, key, reason: '恢复全局人格', persist: () => chatSettings.remove(key) })
      else chatSettings.remove(key)
      return { ok: true }
    },
    async 'get-persona'(payload) {
      const file = personaPath(payload.name)
      return { name: payload.name, content: existsSync(file) ? readFileSync(file, 'utf8') : '' }
    },
    async 'export-persona'() {
      const { buildSystemPrompt } = await import('../persona.js')
      // 导出运行中实际使用的人格，不混入记忆、密钥或临时聊天上下文。
      const name = String(config.activePersona || config.botName || '默认人格')
      const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60)
      const content = config.persona || buildSystemPrompt({ botName: config.botName || 'Koukou' })
      return { name, filename: `Koukou-${safe}-人格.txt`, content }
    },
    async 'export-persona-package'(payload) {
      const {buildSystemPrompt}=await import('../persona.js')
      const name=String(payload?.name||config.activePersona||config.botName||'默认人格')
      const content=payload?.content??(config.persona||quietGreetings?.defaultPersona?.()||buildSystemPrompt({botName:config.botName,now:new Date('2000-01-01T00:00:00Z')}))
      if(typeof content!=='string'||!content.trim()||content.length>262144)throw Error('人格正文无效')
      const safe=name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,60)
      const bundle={format:'koukou-persona',version:1,name,content,greetings:personaGreetings?.exportFor(content)??null}
      return {filename:`Koukou-${safe}-人格.json`,content:JSON.stringify(bundle,null,2)}
    },
    async 'send-morning-greetings'() {
      if(!quietGreetings)throw Error('早晚安未加载')
      return quietGreetings.catchUpMorning()
    },
    async 'get-greeting-library'(payload) {
      const content=String(payload?.content??config.persona??'')
      return {library:personaGreetings?.exportFor(content)??null}
    },
    async 'save-greeting-library'(payload) {
      if(!personaGreetings)throw Error('人格语库未加载')
      const content=payload?.content
      if(typeof content!=='string'||!content.trim()||content.length>262144)throw Error('请先填写有效的人格正文')
      return {ok:true,library:personaGreetings.set(content,payload.library)}
    },
    async 'import-persona'(payload) {
      const name = String(payload?.name ?? '').trim()
      if (typeof payload?.content !== 'string') throw Error('人格内容必须是纯文本')
      const content = String(payload?.content ?? '').replace(/^\uFEFF/, '')
      if (!name || name.length > 60 || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw Error('人格名称需为 1～60 字，不能含路径或文件名保留字符')
      if (!content.trim()) throw Error('人格文件内容为空')
      if (content.length > 262144 || content.includes('\u0000')) throw Error('人格文件过大或不是纯文本')
      const file = personaPath(name)
      if (existsSync(file) || listPersonas().some(p => p.name.toLowerCase() === name.toLowerCase())) throw Error('同名人格已存在，请修改名称；原人格不会被覆盖')
      if(payload?.greetings){
        if(!personaGreetings)throw Error('人格语库未加载')
        personaGreetings.validateImport(content,payload.greetings)
        personaGreetings.set(content,payload.greetings)
      }
      mkdirSync(personaDir, { recursive: true })
      writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' })
      return { ok: true, name, content }
    },
    async 'get-appendix'() {
      const { buildChatAppendix } = await import('../chatAppendix.js')
      return { text: buildChatAppendix({ time: new Date().toLocaleString('zh-CN', { hour12: false }) }) }
    },
    async 'save-persona'(payload) {
      const { name, content } = payload
      if (!name) throw new Error('缺少人格名')
      mkdirSync(personaDir, { recursive: true })
      writeFileSync(personaPath(name), String(content ?? ''))
      return { ok: true }
    },
    async 'create-persona'(payload) {
      const { name, content } = payload
      if (!name) throw new Error('缺少人格名')
      const file = personaPath(name)
      if (existsSync(file)) throw new Error('同名人格已存在')
      mkdirSync(personaDir, { recursive: true })
      writeFileSync(file, String(content ?? '你是群里的一员。'))
      return { ok: true }
    },
    async 'delete-persona'(payload) {
      const file = personaPath(payload.name)
      if (existsSync(file)) rmSync(file)
      return { ok: true }
    },
    async 'activate-persona'(payload) {
      const { name } = payload
      if (!name) throw new Error('缺少人格名')
      const file = personaPath(name)
      if (!existsSync(file)) throw new Error('人格文件不存在')
      const result = activatePersona({ name, content: readFileSync(file, 'utf8').trim(), config, memory, longMemory, targetWatch,
        persist: () => writeEnvFile(envFile, { ACTIVE_PERSONA: name }, { atomic: true }) })
      logger?.info?.(`[控制台] 切换人格为「${name}」`)
      return result
    },
    async 'save-custom-command'(payload) {
      if(payload?.event!=='poke'&&commandCenter){
        const aliases=Array.isArray(payload.aliases)?payload.aliases:String(payload.aliases||'').split(/[,，\n]/)
        if([payload.trigger,...aliases].some(t=>commandCenter.detect(t||'')))throw Error('触发词已由内置功能使用，请编辑已有功能或更换触发词')
      }
      const saved = customCommands.upsert(payload || {})
      commandCenter?.touch()
      logger?.info?.(`[控制台] 保存自定义指令「${saved.name}」`)
      return { ok: true, item: saved }
    },
    async 'delete-custom-command'(payload) {
      const ok = customCommands.remove(payload?.id)
      commandCenter?.touch()
      return { ok, removed: ok }
    },
    async 'save-builtin-command'(payload){return {ok:true,item:commandCenter.saveBuiltin(payload)}} ,
    async 'generate-command'(payload){return {ok:true,draft:await commandCenter.generate(payload.description,{mode:payload.mode})}},
    async 'export-commands'(payload){return commandCenter.exportPack(payload)},
    async 'preview-commands'(payload){return commandCenter.preview(payload.content)},
    async 'import-commands'(payload){return {ok:true,...commandCenter.importPack(payload.content,{includeBuiltins:payload.includeBuiltins===true})}},
    async 'check-poke'(){return {ok:true,diagnostics:commandCenter.diagnostics(),enabled:commandCenter.enabled('poke'),note:'请在 QQ 拍机器人头像；此处只检查事件接收情况，不发送测试消息。'}},
    async 'clear-memory'(payload) {
      const key = String(payload?.key ?? '').trim()
      const all = payload?.all === true
      if (!all && !key) throw new Error('请选择需要清理的会话')
      const result = resetConversationMemory({ config, memory, longMemory, targetWatch, key: all ? null : key, reason: '控制台清除记忆' })
      logger?.info?.(`[控制台] 已重置${all ? '全部' : key}会话记忆并备份`)
      return { ok: true, key, all, ...result }
    },
    async 'watch-target'(payload) {
      // 设置/取消盯人目标：改配置 → 立即重启盯人定时器 → 写回 .env，下次启动仍然生效
      const key = String(payload?.key || '')
      const gid = keyToGroupId(key)
      if (gid === null) throw new Error('盯人目标只能是群会话')
      if (payload?.enabled === false) {
        writeEnvFile(envFile, { TARGET_WATCH_ENABLED: '0', TARGET_WATCH_GROUP: '', TARGET_WATCH_USER: '' }, { atomic: true })
        targetWatch.configure({ enabled: false, groupId: '', userId: '' })
        return { ok: true, enabled: false, groupId: '', userId: '' }
      }
      const uid = String(payload?.userId ?? '').trim()
      if (!/^\d{4,12}$/.test(uid)) throw new Error('请填写要盯的 QQ 号（4～12 位数字）')
      writeEnvFile(envFile, { TARGET_WATCH_ENABLED: '1', TARGET_WATCH_GROUP: String(gid), TARGET_WATCH_USER: uid }, { atomic: true })
      const st = targetWatch.configure({ enabled: true, groupId: String(gid), userId: uid })
      return { ok: true, ...st }
    },
    async 'restart-bot'() {
      logger?.info?.('[控制台] 收到重启机器人指令')
      setTimeout(() => restartBot?.(), 300)
      return { ok: true }
    },
    async 'restart-napcat'() {
      // 必须**先杀掉正在跑的实例再启动**：只 start 不 kill 会同时跑起两个 NapCat，
      // 新实例没有登录态、停在扫码界面，旧实例还占着端口——用户会以为"掉线了"。
      // 目录和任务名走配置（NAPCAT_DIR / NAPCAT_TASK_NAME）：并行跑第二个 NapCat 时，
      // 在新实例的控制台点这个按钮绝不能把旧号重启掉。
      if (!config.napcatDir) throw new Error('请先设置 NAPCAT_DIR（NapCat 安装目录）')
      const dir = String(config.napcatDir).replace(/'/g, "''")
      const task = String(config.napcatTaskName || 'NapCatQQ').replace(/'/g, "''")
      const ps = [
        `$dir = '${dir}'`,
        "$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($dir + '\\*') })",
        'if ($procs.Count -gt 0) { $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 3 }',
        `Start-ScheduledTask -TaskName '${task}'`,
      ].join('; ')
      await new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', ps], (err) => (err ? reject(err) : resolve()))
      })
      logger?.info?.(`[控制台] 已重启 NapCat（${dir} / 任务 ${task}，先结束旧实例再启动新实例）`)
      return { ok: true, killed: 'old-instances-then-start', dir, task }
    },
    async summary(payload) {
      if (payload?.missingOnly === true) {
        if (!dailySummary || !config.summaryFallbackEnabled) throw new Error('请先启用群总结和漏发补发')
        dailySummary.checkScheduled('23:30', undefined, { earlyFallback: true,
          ...(payload.groupId ? { groupIds: [Number(payload.groupId)] } : {}), statsOnly: payload.statsOnly === true })
          .catch(err => logger.error(`[手动提前补发] 失败：${err.message}`))
        return { ok: true, missingOnly: true, replacesFallback: true }
      }
      const groups = payload.groupId ? [Number(payload.groupId)] : config.summaryGroups.length ? config.summaryGroups : [...config.whitelistGroups]
      if (!dailySummary) throw new Error('日报模块未启用')
      dailySummary.trigger(groups, { days: Math.max(1, Math.min(30, Number(payload.days) || 1)) })
      return { ok: true, groups }
    },
    async say(payload) {
      const key = String(payload.key || '')
      const text = String(payload.text || '').trim()
      if (!text) throw new Error('内容不能为空')
      const gid = keyToGroupId(key)
      const uid = keyToUserId(key)
      if (gid !== null) await onebot.sendGroup(gid, text)
      else if (uid !== null) await onebot.sendPrivate(uid, text)
      else throw new Error('会话 key 无法识别')
      return { ok: true }
    },
    /** 手动触发一次「定时指令」（默认：@示例机器人 /今日猪猪），用于验证与补发 */
    async 'daily-ping'() {
      if (!dailyPing) throw new Error('定时指令模块未启用')
      const ok = await dailyPing.sendNow('控制台手动触发')
      return { ok, config: dailyPing.describe() }
    },
    /**
     * 群名片核对：dryRun 默认 true（只列名单不发消息），显式传 false 才真的 @ 他们提醒改名。
     * 用来在群里动手之前先看清谁会中招。
     */
    async 'id-check'(payload) {
      if (!bot?.checkGroupMembers) throw new Error('名单核对模块未启用')
      const groupId = Number(payload.groupId || config.idCheckGroups[0] || 0)
      if (!groupId) throw new Error('没指定群号')
      const { total, bad, skipped } = await bot.checkGroupMembers(groupId)
      const list = bad.map((b) => ({ userId: b.userId, name: b.name, reason: b.reason }))
      const skippedList = (skipped || []).map((s) => ({ userId: s.userId, name: s.name, why: s.why }))
      if (payload.dryRun !== false) {
        logger?.info?.(`[控制台] 名单核对干跑（群 ${groupId}）：${bad.length}/${total} 人不合格，跳过 ${skippedList.length} 人`)
        return { ok: true, dryRun: true, groupId, total, badCount: bad.length, list, skipped: skippedList }
      }
      await bot.runIdCheck({ message_type: 'group', group_id: groupId, user_id: onebot.selfId }, groupId)
      return { ok: true, dryRun: false, groupId, total, badCount: bad.length, list, skipped: skippedList }
    },
    /**
     * 踢人前置条件查询 / 执行。
     * dryRun 默认 true：只回报"现在能不能踢、因为什么不能踢"，**不踢任何人**。
     * 显式传 dryRun:false 才会真的踢（前提是全套条件都满足）。
     */
    async 'id-check-kick'(payload) {
      if (!bot?.idCheckKickStatus) throw new Error('踢人模块未启用')
      const groupId = Number(payload.groupId || config.idCheckGroups[0] || 0)
      if (!groupId) throw new Error('没指定群号')
      const userId = String(payload.userId || config.idCheckOperators[0] || '')
      const status = await bot.idCheckKickStatus(groupId, userId)
      if (payload.dryRun !== false) {
        logger?.info?.(`[控制台] 踢人条件查询（群 ${groupId}）：${status.can ? '可以踢' : '不能踢'} —— ${status.reason}`)
        return { ok: true, dryRun: true, groupId, userId, ...status }
      }
      if (!status.can) {
        // 与群里保持一致：条件不满足就什么都不做（但控制台要如实回报原因，不能也静默）
        logger?.warn?.(`[控制台] 踢人被拒（群 ${groupId}）：${status.reason}`)
        return { ok: false, dryRun: false, groupId, userId, kicked: 0, ...status }
      }
      await bot.runIdCheckKick({ message_type: 'group', group_id: groupId, user_id: userId }, groupId)
      return { ok: true, dryRun: false, groupId, userId, kicked: status.list.length, list: status.list }
    },
    async 'poke-target'() {
      if (!targetWatch?.enabled) {
        return { ok: false, enabled: false, note: '盯人回复未启用：先在群会话卡片里点「设为盯人」' }
      }
      const n = targetWatch.pendingCount?.() ?? 0
      await targetWatch.tick()
      return { ok: true, pendingBefore: n }
    },
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(body)
    }
    try {
      if (req.method==='GET'&&url.pathname==='/command-center.js') return send(200,readFileSync(path.join(__dirname,'commandCenter.js')),'text/javascript; charset=utf-8')
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!existsSync(UI_FILE)) return send(500, '控制台界面文件缺失', 'text/plain; charset=utf-8')
        return send(200, readFileSync(UI_FILE), 'text/html; charset=utf-8')
      }
      if (url.pathname.startsWith('/api/')) {
        const query = Object.fromEntries(url.searchParams.entries())
        if (req.method === 'GET') {
          const handler = routes[`GET ${url.pathname}`]
          if (!handler) return send(404, JSON.stringify({ error: 'no such route' }))
          return send(200, JSON.stringify(await handler(query)))
        }
        if (req.method === 'POST') {
          const body = await new Promise((resolve) => {
            let data = ''
            req.on('data', (c) => {
              data += c
              if (data.length > 2_000_000) req.destroy()
            })
            req.on('end', () => {
              try {
                resolve(JSON.parse(data || '{}'))
              } catch {
                resolve({})
              }
            })
          })
          // 动作路径：/api/action/<名字>（也兼容 /api/<名字>）
          const action = url.pathname.startsWith('/api/action/')
            ? url.pathname.slice('/api/action/'.length)
            : url.pathname.replace('/api/', '')
          const handler = actions[action]
          if (!handler) return send(404, JSON.stringify({ error: 'no such action' }))
          return send(200, JSON.stringify(await handler(body)))
        }
      }
      return send(404, 'Not Found', 'text/plain; charset=utf-8')
    } catch (err) {
      logger?.warn?.(`[控制台] ${req.method} ${url.pathname} 出错：${err.message}`)
      return send(400, JSON.stringify({ error: err.message }))
    }
  })

  function start(port = 8787) {
    return new Promise((resolve) => {
      server.on('error', (err) => {
        logger?.warn?.(`控制台启动失败（端口 ${port}）：${err.message}`)
        resolve(null)
      })
      server.listen(port, '127.0.0.1', () => {
        logger?.info?.(`机器人控制台已启动：http://127.0.0.1:${port}`)
        resolve(server)
      })
    })
  }

  return { start, server, buildState, buildChatList, listPersonas, actions, routes }
}
