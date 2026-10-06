/**
 * 群聊统计：日报里的数字必须由代码精确计算。
 *
 * 让模型"数一数群里发了多少条、谁表情占比多少"是行不通的——它数不准，只会编一个看起来
 * 合理的数字。所以这里把能算的全部算好，模型只负责写定性描述。
 */

const FACE_TAG_RE = /\[表情[:：][^[\]]{0,12}\]/g
const EMOJI_RE = /\p{Extended_Pictographic}/gu

const pad2 = (n) => String(n).padStart(2, '0')

/** 单条消息的字数与表情数（[表情:笑哭] 按 1 个字算；[图片] 等非文本消息不计字；emoji 按码点算 1 个字） */
export function analyzeText(text) {
  const s = String(text ?? '')
  const faces = (s.match(FACE_TAG_RE) || []).length
  const emojis = (s.match(EMOJI_RE) || []).length
  const cleaned = s
    .replace(FACE_TAG_RE, '表')
    .replace(/\[(图片|语音|视频)\]/g, '')
    .replace(/\s/g, '')
  // 用码点计数：'🍥'.length 是 2（UTF-16 代理对），但人眼里它就是 1 个字
  const chars = [...cleaned].length
  return { chars, faces, emojis, emojiTotal: faces + emojis }
}

/**
 * 汇总统计。
 * @param {Array<{userId:string,name:string,text:string,time:number,replyId?:string}>} records
 * @returns {{
 *   total:number, people:number, chars:number, emoji:number, peak:string,
 *   hourHistogram:number[], users:Array<object>
 * }}
 */
export function computeSummaryStats(records) {
  const list = Array.isArray(records) ? records : []
  const hour = new Array(24).fill(0)
  const byUser = new Map()
  let chars = 0
  let emoji = 0

  for (const r of list) {
    const { chars: c, emojiTotal } = analyzeText(r.text)
    chars += c
    emoji += emojiTotal
    const h = new Date((Number(r.time) || 0) * 1000).getHours()
    if (Number.isFinite(h) && h >= 0 && h < 24) hour[h] += 1

    const key = String(r.userId ?? r.name ?? '?')
    let u = byUser.get(key)
    if (!u) {
      u = { userId: key, name: String(r.name ?? key), count: 0, chars: 0, emoji: 0, replies: 0 }
      byUser.set(key, u)
    }
    u.count += 1
    u.chars += c
    u.emoji += emojiTotal
    if (r.replyId) u.replies += 1
  }

  // 最活跃时段（默认 1 小时窗口）
  let peakHour = -1
  let peakCount = 0
  for (let i = 0; i < 24; i++) {
    if (hour[i] > peakCount) {
      peakCount = hour[i]
      peakHour = i
    }
  }
  const peak = peakHour < 0 ? '—' : `${pad2(peakHour)}:00-${pad2((peakHour + 1) % 24)}:00`

  const users = [...byUser.values()]
    .map((u) => ({
      ...u,
      avgChars: u.count > 0 ? Math.round((u.chars / u.count) * 10) / 10 : 0,
      emojiRatio: u.count > 0 ? Math.round((u.emoji / u.count) * 100) / 100 : 0,
      replyRatio: u.count > 0 ? Math.round((u.replies / u.count) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.count - a.count || b.chars - a.chars)

  return { total: list.length, people: users.length, chars, emoji, peak, hourHistogram: hour, users }
}

/** 给模型看的"每人数据"表（它要据此写群友称号，必须是真数据） */
export function formatUserTable(stats, { limit = 20 } = {}) {
  return stats.users
    .slice(0, limit)
    .map(
      (u) =>
        `- ${u.name}（QQ ${u.userId}）：发言 ${u.count} 条｜平均 ${u.avgChars} 字｜表情占比 ${u.emojiRatio}｜回复比例 ${u.replyRatio}`,
    )
    .join('\n')
}

/** 📊 基础统计 区块（完全由代码生成，保证数字准确） */
export function formatStatsBlock(stats) {
  return [
    '📊 基础统计',
    `• 消息总数: ${stats.total}`,
    `• 参与人数: ${stats.people}`,
    `• 总字符数: ${stats.chars}`,
    `• 表情数量: ${stats.emoji}`,
    `• 最活跃时段: ${stats.peak}`,
  ].join('\n')
}

/** 报告里的日期行：📅 2026年09月04日（跨天时用 ~ 连接） */
export function formatReportDate(startKey, endKey = startKey) {
  const fmt = (key) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
    return m ? `${m[1]}年${m[2]}月${m[3]}日` : String(key ?? '')
  }
  return startKey === endKey ? fmt(startKey) : `${fmt(startKey)} ~ ${fmt(endKey)}`
}
