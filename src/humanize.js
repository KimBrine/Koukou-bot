/**
 * 拟人化与反检测工具集。
 *
 * 说明：腾讯判定的核心依据是"协议客户端特征"，行为层面无法根除；
 * 但"秒回、刷屏、高度规律、装饰符号密度异常"这些行为特征会显著提高风控触发概率，
 * 本模块负责把这些特征压到接近真人的水平。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 装饰符号（颜文字 / emoji / QQ 表情）────────────────────────────────
const KAOMOJI_SYMBOLS = '=^▽ωﾉ≧≦ΣД゜∀´`ˊˋ・﹏๑٩۶◕‿⌒ノヽゞヾミ＞＜＾°◡ᴗಥஇ｡•︿﹃﹄⊙△▼▼∀⌒'
const COMBINING_MARKS = '[\u0300-\u036F\u20D0-\u20FF]'
const KAOMOJI_PAREN = new RegExp(`[（(][^（）()]{0,20}(?:[${KAOMOJI_SYMBOLS}]|${COMBINING_MARKS})[^（）()]{0,20}[）)]`, 'g')
const KAOMOJI_BARE = new RegExp(`[${KAOMOJI_SYMBOLS}]{1,}`, 'g')
const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu
const TIC_RE = /(awa|qwq|QAQ|TAT|XD|Orz|orz)/g
const FACE_MARK_RE = /\[表情[:：]\s*[^\[\]]{1,12}\]/g

/**
 * 所有装饰符号的匹配正则（每次调用返回新实例，避免 /g 的 lastIndex 状态污染）。
 * 供长度计算与安全裁剪复用：装饰符号按 1 个字算，且裁剪时绝不从中间切断
 * （把 "(=^▽^=)" 砍成 "(=^▽" 发出去，比不发颜文字还难看）。
 *
 * ⚠️ 必须带 u 标志：emoji 分支用的是 `\p{Extended_Pictographic}`，没有 u 标志时这个
 * Unicode 属性转义会退化成**字面字符集**，把 p、{、E、x、t、a… 这些字母也算成装饰符号，
 * 结果任何含英文字母的回复都会被误判（"awa" 里的 a 会被当作装饰，裁剪定位全乱）。
 */
export function decorationRe(flags = 'g') {
  const f = String(flags).includes('u') ? String(flags) : `${flags}u`
  return new RegExp(
    `(?:${FACE_MARK_RE.source}|${KAOMOJI_PAREN.source}|${KAOMOJI_BARE.source}|${EMOJI_RE.source}|${COMBINING_MARKS}|${TIC_RE.source})`,
    f,
  )
}

/** 判断文本里是否含装饰符号 */
export function hasDecoration(text) {
  const s = String(text ?? '')
  if (!s) return false
  FACE_MARK_RE.lastIndex = 0
  KAOMOJI_PAREN.lastIndex = 0
  KAOMOJI_BARE.lastIndex = 0
  return (
    FACE_MARK_RE.test(s) ||
    KAOMOJI_PAREN.test(s) ||
    KAOMOJI_BARE.test(s) ||
    /\p{Extended_Pictographic}/u.test(s) ||
    new RegExp(COMBINING_MARKS).test(s) ||
    /(awa|qwq|QAQ|XD)/.test(s)
  )
}

/** 去掉所有装饰符号，并修整标点/空白 */
export function stripDecoration(text) {
  let s = String(text ?? '')
  s = s.replace(FACE_MARK_RE, '')
  s = s.replace(KAOMOJI_PAREN, '')
  s = s.replace(KAOMOJI_BARE, '')
  s = s.replace(EMOJI_RE, '')
  s = s.replace(new RegExp(COMBINING_MARKS, 'g'), '')
  s = s.replace(TIC_RE, '')
  // 清理颜文字残留：只删空括号、首尾孤立括号、连续括号，
  // 含正文的括号要保留（「他说（明天）可以」不能变成「他说明天可以」）
  s = s.replace(/[（(]\s*[)）]/g, '')
  s = s.replace(/^[\s，。！？～…、·]*[)）]+/, '').replace(/[（(]+[\s，。！？～…、·]*$/, '')
  s = s.replace(/[（(]+(?=\s*[)）])/g, '').replace(/[)）]+(?=[（(])/g, '')
  // 修整：多余空格、空格前置标点、首尾标点
  s = s
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([，。！？～…、）)])/g, '$1')
    .replace(/^[\s，。！？～…、·]+/, '')
    .replace(/[\s，、·]+$/, '')
  return s.trim()
}

/**
 * 按概率保留装饰符号：keepRate=0.2 表示约 20% 的消息保留颜文字/emoji，其余纯文字。
 * 若去掉后内容为空（例如整条只有表情），则保留原文，避免发出空消息。
 */
export function limitDecoration(text, keepRate = 0.2) {
  const s = String(text ?? '').trim()
  if (!s || !hasDecoration(s)) return s
  if (Math.random() < keepRate) return s
  const stripped = stripDecoration(s)
  if (stripped.replace(/[\s\p{P}]/gu, '').length === 0) return s
  return stripped
}

/**
 * 多行回复的装饰符号控制：**整条回复统一决策**（保持"每 5 条最多 1 条带装饰"的频率），
 * 但**逐行处理**——不能把多行拼成一个字符串再清洗，否则某行被删空后换行会被压平，
 * 两条消息会粘成一条（表现为「笑死我了 你也太逗了」这种带空格的一行）。
 */
/**
 * 判断一行是不是数学/代码：这类内容里的括号、等号、运算符不能被当成颜文字删掉。
 * 例：(x-2)(x-3)=0、a^2+b^2、x=3、`code`、if (a < b)
 */
export function looksLikeCodeOrMath(line) {
  const s = String(line ?? '')
  if (!s) return false
  if (/\`[^\`]+\`/.test(s)) return true
  if (/[A-Za-z0-9}]\s*[=<>]\s*[-A-Za-z0-9(\[]/.test(s)) return true
  if (/[A-Za-z0-9)(]\s*[\^+*/]\s*[A-Za-z0-9(]/.test(s)) return true
  if (/[A-Za-z0-9]\s*-\s*[A-Za-z0-9(]/.test(s) && /[=()\[\]^+*/]/.test(s)) return true
  if (/[√∑∫≤≥≠≈π]/.test(s)) return true
  return false
}

export function limitDecorationLines(lines, keepRate = 0.2) {
  const list = (Array.isArray(lines) ? lines : [lines])
    .map((s) => String(s ?? '').trim())
    .filter((s) => s.length > 0)
  if (list.length === 0) return []
  if (Math.random() < keepRate) return list
  return list.map((line) => {
    if (!hasDecoration(line)) return line
    // 数学/代码行原样保留：把 (x-2) 当成颜文字删掉会让解题答案变成乱码
    if (looksLikeCodeOrMath(line)) return line
    const stripped = stripDecoration(line)
    // 整行只有装饰（例如整条就是个表情）：去掉就空了，保留原样，避免发出空消息
    return stripped.replace(/[\s\p{P}]/gu, '').length === 0 ? line : stripped
  })
}

// ── 拟人发送节奏 ────────────────────────────────────────────────────────
/** 随机"打字"延迟，避免毫秒级秒回 */
export function typingDelay({ min = 600, max = 2500 } = {}) {
  const ms = Math.floor(min + Math.random() * Math.max(0, max - min))
  return sleep(ms)
}

/** 滑动窗口限流：普通聊天整段计一次，独立动作按调用方记录；保留发送间隔。 */
export function createRateLimiter({ perHour = 25, minGapMs = 4000 } = {}) {
  const lastSent = new Map() // key -> 上次发送时间戳
  const history = new Map() // key -> [时间戳...]

  return {
    /**
     * 是否允许发送；allowed=false 时给出原因。
     * ignoreGap=true 仅检查每小时额度；普通聊天的一段回复只在首条成功时计数。
     *
     * 间隔不够时返回 retryable=true 与 retryAfterMs —— 调用方**应该等一会儿再发，而不是丢掉这条消息**。
     * （曾经直接丢掉：私聊里连续两三秒发几条，后面几条就被静默丢弃，用户只看到"机器人不回"。）
     */
    check(key, now = Date.now(), { ignoreGap = false, perHourLimit = null } = {}) {
      const gap = now - (lastSent.get(key) || 0)
      if (!ignoreGap && minGapMs > 0 && lastSent.has(key) && gap < minGapMs) {
        return {
          allowed: false,
          retryable: true,
          retryAfterMs: minGapMs - gap,
          reason: `距上次发言仅 ${Math.round(gap / 1000)}s（下限 ${Math.round(minGapMs / 1000)}s）`,
        }
      }
      // perHourLimit：本次检查用更高的额度（"被@必回 / 私聊"这类不能丢的消息专用）。
      // 额度是同一个桶里的计数，只是阈值不同——所以主动搭话/盯人会在 25 条时先停，
      // 把"必回"的余量留出来，而不是让盯人把额度刷满、@ 消息被当成超额度丢弃。
      const cap = perHourLimit ?? perHour
      if (cap > 0) {
        const arr = (history.get(key) || []).filter((t) => now - t < 3600_000)
        if (arr.length >= cap) {
          return { allowed: false, retryable: false, reason: `本会话一小时内已发言 ${arr.length} 次（上限 ${cap}）` }
        }
      }
      return { allowed: true }
    },
    /** 记录一次成功发送 */
    record(key, now = Date.now()) {
      lastSent.set(key, now)
      const arr = history.get(key) || []
      arr.push(now)
      history.set(key, arr.filter((t) => now - t < 3600_000))
    },
    /** 同一段的后续分条更新最小间隔起点，不增加小时计数。 */
    touch(key, now = Date.now()) { lastSent.set(key, now) },
  }
}

/** 安静时段（如 01:00-07:00）：此时段只回应 @，不主动搭话 */
export function isQuietHour(spec, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim())
  if (!m) return false
  const toMin = (h, mi) => Number(h) * 60 + Number(mi)
  const start = toMin(m[1], m[2])
  const end = toMin(m[3], m[4])
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  return start < end ? cur >= start && cur < end : cur >= start || cur < end // 跨天
}
