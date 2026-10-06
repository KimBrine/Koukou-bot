/**
 * 回复形态：长度自适应 + 多行分条。
 *
 * 目标：让回复的"体量"跟着对方走，而不是不管对方说什么都吐一样长的一段话。
 * 机器味最重的特征之一就是"长度恒定"——人不会对着"嗯"回 40 个字，也不会对着
 * 一长段吐槽只回一个"哦"。
 *
 * 规则（默认，均可在 .env 调整）：
 * - 以一行回复为主（约 7~8 成），内容确实多时才分 2~3 行；
 * - 每行 ≤ REPLY_LINE_MAX_CHARS（默认 40）字，总字数跟随对方消息长度；
 * - 分行时每一行由上层单独作为一条消息发出（拟人：分条发消息）；
 * - 对方若有多条消息没被回复，按 35% 折算计入长度预算（像真人"一口气回几句"）。
 */

import { decorationRe } from './humanize.js'

const IMAGE_TAG_RE = /\[图片\]/g
const QUOTE_TAG_RE = /^\[引用[^\]]{0,300}\]\s*/
const NAME_PREFIX_RE = /^【[^】]{0,24}】/
const AT_PREFIX_RE = /^@[^\s，,。！？!?]{0,24}\s*/

/**
 * 衡量一句消息"有多长"（用于长度匹配）。
 * 装饰符号（颜文字 / emoji / 🍥 / [表情:名字]）一律按 **1 个字**算：
 * 它们是语气不是内容——`(=^▽^=)` 明明只表达"开心"，按 8 个字算会把预算吃光，
 * 结果就是模型想卖萌却塞不进去，只能干巴巴回一句。
 */
export function measureText(text) {
  let s = String(text ?? '')
  s = s.replace(decorationRe('g'), '饰')
  s = s.replace(IMAGE_TAG_RE, '')
  s = s.replace(QUOTE_TAG_RE, '')
  s = s.replace(NAME_PREFIX_RE, '')
  s = s.replace(AT_PREFIX_RE, '')
  return s.replace(/\s+/g, '').length
}

/**
 * 尚未被回复的消息总长度：从历史末尾往前数，直到遇到机器人自己的回复为止。
 * 这对应"对方连发了好几条，我这次要一起回"的场景。
 */
export function backlogLength(history, { cap = 240 } = {}) {
  let sum = 0
  const list = Array.isArray(history) ? history : []
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (!item || item.role !== 'user') break
    sum += measureText(item.content)
    if (sum >= cap) return cap
  }
  return sum
}

/**
 * 本次回复用几行：短消息压倒性一行；对方说得比"一行能装下的量"还多时，
 * 几乎必然分行——否则长度根本对不上（人不会用一行 20 字回你 100 字的吐槽）。
 * maxLines=1 时永远单行；rand 可注入便于测试。
 */
export function pickLineCount(targetLen, { maxLines = 3, lineMaxChars = 40, rand = Math.random } = {}) {
  if (maxLines <= 1) return 1
  // 内容太短不值得分条：一句话就说完了（把「在吗」拆成两条发，比机器人还像机器人）
  if (targetLen < 16) return 1
  let p2
  let p3
  if (targetLen <= 20) {
    p2 = 0.13
    p3 = 0.02
  } else if (targetLen <= lineMaxChars) {
    p2 = 0.32
    p3 = 0.09
  } else if (targetLen <= lineMaxChars * 2) {
    p2 = 0.5
    p3 = 0.32
  } else {
    // 对方说的量已经超过两行能装下的：必须多行才可能长度相当
    p2 = 0.24
    p3 = 0.72
  }
  const r = rand()
  let lines = 1
  if (r < p3) lines = 3
  else if (r < p3 + p2) lines = 2
  // 内容量不足两行时最多分两条（否则每行只剩几个字，读起来是碎片）
  if (targetLen < 30) lines = Math.min(lines, 2)
  return Math.min(lines, maxLines)
}

/**
 * 规划本次回复的形态。
 * @returns {{targetLen:number, lines:number, budget:number, perLineCap:number, lineMaxChars:number}}
 *   targetLen    本次希望的总字数（对方长度 + 未回消息折算）
 *   lines        计划分几行（= 几条消息）
 *   budget       总字数上限
 *   perLineCap   单行字数上限
 */
export function planReply({
  incomingLen = 0,
  backlogLen = 0,
  maxLines = 3,
  lineMaxChars = 40,
  matchEnabled = true,
  backlogWeight = 0.35,
  rand = Math.random,
} = {}) {
  const target = Math.max(0, Math.round(incomingLen + backlogLen * backlogWeight))
  const lines = matchEnabled ? pickLineCount(target, { maxLines, lineMaxChars, rand }) : 1
  // 预算：跟着对方长度走，再给几个字余量；下限 8 字（避免出现"嗯"这种没有信息的回复），
  // 上限 = 行数 × 单行上限（多行不代表可以无限长）
  const budget = Math.max(8, Math.min(lines * lineMaxChars, Math.round(target * 1.15) + 8))
  const perLineCap = Math.max(8, Math.min(lineMaxChars, Math.ceil(budget / lines) + 6))
  return { targetLen: target, lines, budget, perLineCap, lineMaxChars }
}

/**
 * 截断点若落在装饰符号中间（颜文字 / emoji / [表情:xxx]），就补全整个装饰、或整段丢掉。
 * 残缺装饰（"(=^▽"、"[表情:dog…"）发出去是乱码文字——比不发还难看，必须避免。
 */
function completeDecoration(cut, full, limit) {
  if (!cut) return cut
  // 省略号路径会把最后一个字符换成 "…"，此时 cut 不再是 full 的前缀，
  // 必须用"去掉省略号后的核心长度"去和装饰符号在 full 中的区间比较，否则永远判不出来。
  const core = cut.endsWith('…') ? cut.slice(0, -1) : cut
  const re = decorationRe('g')
  let m
  while ((m = re.exec(full)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (start >= core.length) break
    if (core.length > start && core.length < end) {
      // 装饰符号只算 1 个字，略微超限可以接受；超太多就整段丢掉
      if (end <= limit + 16) return full.slice(0, end).trim()
      return full.slice(0, start).trim()
    }
  }
  return cut
}

/**
 * 去掉装饰符号后的"正文字数"。
 * 装饰符号不占长度预算——它们是调味不是内容。否则会出现这种事：
 * 回复「都是群里大家说的呀🍥」在 9 字预算下被裁成「都是群里大家说的…」，
 * 模型明明听话带了 🍥，用户却永远看不到（这正是"🍥 总是不出现"的结构性原因）。
 */
export function contentLength(text) {
  return String(text ?? '')
    .replace(decorationRe('g'), '')
    .replace(/\s/g, '').length
}

/** 一段文本里装饰符号占掉的字符数（裁剪时要把这部分额度补回去） */
function decorationChars(text) {
  return Math.max(0, String(text ?? '').length - contentLength(text))
}

/** 在 limit 字内按句末标点 → 逗号 → 硬截断的顺序裁剪，尽量不砍断句子，也绝不砍断装饰符号 */
export function trimTo(text, limit) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  if (s.length <= limit) return s
  const head = s.slice(0, limit)
  const bySentence = head.match(/^[\s\S]*[。！？!?～~…]/)
  if (bySentence && bySentence[0].trim().length >= 4) return completeDecoration(bySentence[0].trim(), s, limit)
  const byComma = head.match(/^[\s\S]*[，,、]/)
  if (byComma && byComma[0].trim().length >= 6) {
    return completeDecoration(byComma[0].trim().replace(/[，,、]$/, ''), s, limit)
  }
  return completeDecoration(`${head.slice(0, Math.max(1, limit - 1)).trim()}…`, s, limit)
}

/** 去掉模型可能自作主张加的列表符号 / 行号 */
function cleanLine(line) {
  return String(line ?? '')
    .replace(/^\s*[-*•·—]+\s*/, '')
    .replace(/^\s*\d+\s*[.、)）]\s*/, '')
    .replace(/^\s*第\s*\d+\s*[条行句]\s*[:：]?\s*/, '')
    .trim()
}

/**
 * 模型把一长段话写成了一行，而本次计划允许 2~3 行时：按句子（其次逗号）边界拆开。
 * 比"硬砍掉后半句"好得多——内容保住，而且分条发出更像真人。
 */
export function splitOneLine(text, maxLines, lineCap) {
  const s = String(text ?? '').trim()
  if (maxLines <= 1 || !s || s.length <= lineCap) return [s]
  // 优先在句末标点后断开（标点跟着前一段）
  let parts = s
    .split(/(?<=[。！？!?…～])/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (parts.length < 2) {
    // 没有句末标点 → 在逗号/顿号处断开（断开处的逗号丢弃，读起来更自然）
    parts = s
      .split(/[，,、]/)
      .map((t) => t.trim())
      .filter(Boolean)
  }
  if (parts.length < 2) return [s]
  // 段数超过上限：从末尾合并，保证不超过计划行数（前段已有标点就不再补逗号，避免「。，」这种连标点）
  while (parts.length > maxLines) {
    const last = parts.pop()
    const prev = parts[parts.length - 1]
    parts[parts.length - 1] = /[。！？!?…～，,、]$/.test(prev) ? `${prev}${last}` : `${prev}，${last}`
  }
  return parts
}

/**
 * 把模型输出的整段文本整理成 1..plan.lines 行，并压进字数预算。
 * - 模型多给了行 → 合并进最后一行再统一裁剪（不丢信息）；
 * - 模型只给一行但内容超长、且本次计划有多行 → 按句子边界拆成多条；
 * - 单行超长 → 按句子边界裁到 perLineCap；
 * - 总长超预算 → 从最后一行往前收，保住开头最核心的表达。
 */
export function shapeReply(raw, plan) {
  const maxLines = Math.max(1, plan?.lines ?? 1)
  const lineCap = Math.max(8, plan?.perLineCap ?? plan?.lineMaxChars ?? 40)
  const budget = Math.max(4, plan?.budget ?? lineCap)
  const fallback = () => {
    const t = cleanLine(String(raw ?? '').replace(/\s*\n\s*/g, ' '))
    return t ? [trimTo(t, Math.min(lineCap, budget))] : []
  }

  let lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(cleanLine)
    .filter((s) => s.length > 0)

  if (lines.length === 0) return fallback()
  if (lines.length === 1 && maxLines > 1) {
    const split = splitOneLine(lines[0], maxLines, lineCap)
    if (split.length > 1 && split.every((s) => s.length > 0)) lines = split
  }
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1)
    const tail = lines.slice(maxLines - 1).join('')
    lines = [...head, tail]
  }
  // 单行上限：装饰符号不占额度，所以把该行装饰占掉的字符数补回给 trimTo
  lines = lines.map((s) => trimTo(s, lineCap + decorationChars(s))).filter((s) => s.length > 0)
  if (lines.length === 0) return fallback()

  // 总预算同样只算正文，装饰符号白送（否则短回复里 🍥/颜文字永远第一个被丢掉）
  let total = contentLength(lines.join(''))
  for (let i = lines.length - 1; i >= 0 && total > budget; i--) {
    const allow = Math.max(4, budget - (total - contentLength(lines[i])))
    lines[i] = trimTo(lines[i], allow + decorationChars(lines[i]))
    total = contentLength(lines.join(''))
  }
  const out = lines.filter((s) => s && s.trim().length > 0)
  return out.length > 0 ? out : fallback()
}

/**
 * 本条回复的装饰"种类"：鱼板 / 颜文字 / 两者都行。
 * **不强绑定**——两者一起用只是其中一种可能（约 2 成），大多数时候只出现一种，
 * 这样看起来才像人的习惯，而不是"每条都 🍥(=^▽^=)"的模板。
 */
export function pickDecorationKind(rand = Math.random) {
  const r = rand()
  if (r < 0.45) return 'fishcake'
  if (r < 0.8) return 'kaomoji'
  return 'both'
}

const KAOMOJI_POOL = ['(=^▽^=)', 'awa', 'QAQ', '(๑•̀ㅂ•́)و✧', 'ヾ(^▽^*)))']

/**
 * 生成本条"要不要带装饰、带哪一种"的要求。
 *
 * 频率只在这里控制（代码按 EMOJI_KEEP_RATE 决定），**不要再在 persona / 系统提示里写百分比**——
 * 两边各写一次等于砍两刀，20% × 20% = 4%，表现就是"几乎不出现颜文字"。
 */
export function decorationHint(allowed, kind = 'fishcake') {
  if (!allowed) {
    return '\n\n【本条回复的装饰】这条请用纯文字回，不要颜文字、emoji，也不要写 [表情:xx]（但"呀/啦/嘛/诶嘿/人家"这类口气照常用）。'
  }
  if (kind === 'kaomoji') {
    return '\n\n【本条回复的装饰】这次可以卖萌：带一个颜文字就好（(=^▽^=)、awa、QAQ、ヾ(^▽^*))) 这类），放句末最自然。'
  }
  if (kind === 'both') {
    return '\n\n【本条回复的装饰】这次可以卖萌：🍥 配一个颜文字一起用也行，两个就够，别堆。'
  }
  return '\n\n【本条回复的装饰】这次可以卖萌：带上你最喜欢的 🍥，放句末，一个就够。'
}

/**
 * 兜底：代码已经决定"这条要卖萌"，模型却一个装饰都没写（或装饰被裁剪弄丢了）→ 按本次种类补上。
 * 模型自己带了装饰就不动它——补的只是"完全没有"这种情况，避免变成强制配对。
 */
export function ensureDecoration(lines, sourceText, { kind = 'fishcake', rand = Math.random } = {}) {
  const list = Array.isArray(lines) ? lines.filter((s) => s && s.length > 0) : []
  if (list.length === 0) return lines
  const present = list.join('')
  // 已经有任何装饰 → 尊重模型的选择，不强加另一种
  if (decorationRe().test(present)) return lines

  const kao = KAOMOJI_POOL[Math.floor(rand() * KAOMOJI_POOL.length) % KAOMOJI_POOL.length]
  let deco = '🍥'
  if (kind === 'kaomoji') deco = kao
  else if (kind === 'both') deco = `🍥${kao}`

  const out = list.slice()
  out[out.length - 1] = `${out[out.length - 1]}${deco}`
  return out
}

/**
 * 生成本条消息的"形态要求"，追加到系统提示词末尾。
 * 这是长度自适应的主要手段（代码层的裁剪只是兜底，避免模型越写越长）。
 */
export function shapeHint(plan) {
  const { targetLen, lines, budget, lineMaxChars } = plan
  const perLine = Math.max(4, Math.min(lineMaxChars, Math.round(budget / Math.max(1, lines))))
  if (lines <= 1) {
    const lo = Math.max(3, Math.round(budget * 0.6))
    return `\n\n【本次回复的形态要求（系统自动生成，绝不要提及它）】对方这条消息大约 ${targetLen} 字。请你也用差不多的长度回：一行写完，${lo}~${budget} 字（不超过 ${lineMaxChars} 字），像微信/QQ 里随口接一句话那样自然。`
  }
  // 关键是给出"目标区间"而不是"上限"：只说上限，模型会理解成"尽量短"，长度就跟不上对方
  const lo = Math.max(4, Math.round((budget / lines) * 0.7))
  const totalLo = lo * lines
  return `\n\n【本次回复的形态要求（系统自动生成，绝不要提及它）】对方这次说的内容大约 ${targetLen} 字，你的回复长度要和他相当。请分成 ${lines} 行写（用换行分隔），每行 ${lo}~${perLine} 字、整体 ${totalLo}~${budget} 字——这是目标长度，请写满一些，不要只丢一句很短的话。系统会把你每一行单独作为一条消息发出去，所以每一行都要是能独立成立、读起来自然的一句话，不要编号、不要列表符号、不要把某一行写成上一行的续句。`
}
