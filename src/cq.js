/**
 * 解析 OneBot 11 消息（兼容 NapCat 的 string / array 两种消息格式）。
 * 返回 { text, atBot, images, replyId, forwards }：
 * - text：可读文本（QQ 表情转成 [表情:名字]，图片转为占位符）
 * - atBot：是否 @ 了机器人
 * - images：[{ file, url }] 消息里的图片/表情包（供视觉模型识图）
 * - replyId / forwards：外层引用 ID 与合并卡片；内层消息不参与触发判断
 */

import { faceName } from './qqFace.js'

export function cqUnescape(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
}

/** 只识别外层卡片；节点内的 @、reply 等不会被提升成当前消息的触发条件。 */
export function forwardSegments(raw) {
  const segments = typeof raw === 'string'
    ? [...raw.matchAll(/\[CQ:(forward|node|json),([^\]]*)\]/g)].map(match => {
      const data = {}
      for (const field of match[2].split(',')) {
        const equal = field.indexOf('=')
        if (equal > 0) data[field.slice(0, equal)] = cqUnescape(field.slice(equal + 1))
      }
      return { type: match[1], data }
    })
    : Array.isArray(raw) ? raw : []
  const result = []
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue
    if (segment.type === 'forward' || segment.type === 'node') {
      result.push(segment)
      continue
    }
    if (segment.type !== 'json') continue
    try {
      const card = typeof segment.data?.data === 'string' ? JSON.parse(segment.data.data) : segment.data?.data
      if (card?.app !== 'com.tencent.multimsg') continue
      const detail = card.meta?.detail || card.meta?.detail_1
      const id = detail?.resid ?? detail?.resId ?? detail?.m_resid
      if (typeof id === 'string' && id.trim()) {
        // 摘要已随外层卡片到达，供群总结在读取完整记录前判断关联性。
        const preview = [detail?.desc, detail?.summary, ...(Array.isArray(detail?.news) ? detail.news.slice(0, 3).map(item => item?.text) : [])]
          .filter(value => typeof value === 'string').map(value => value.slice(0, 200)).join(' ').slice(0, 600)
        result.push({ type: 'forward', data: { id: id.trim(), ...(preview ? { preview } : {}) } })
      }
    } catch { /* 其他 JSON 卡片不当作合并聊天记录。 */ }
  }
  return result
}

export function parseMessage(raw, selfId, { preserveNewlines = false } = {}) {
  const self = selfId == null ? '' : String(selfId)
  let text = ''
  let atBot = false
  let replyId = ''
  const images = []
  const forwards = forwardSegments(raw)

  if (typeof raw === 'string') {
    // CQ 码格式：检测是否 @ 了机器人本人（排除 @全体 与号码前缀误匹配）
    if (self) {
      const atRe = new RegExp(`\\[CQ:at,qq=${self}(\\]|,)`)
      atBot = atRe.test(raw)
    }
    replyId = /\[CQ:reply,id=([^,\]]+)/.exec(raw)?.[1] ?? ''
    const imgRe = /\[CQ:image,[^\]]*\]/g
    let m
    while ((m = imgRe.exec(raw)) !== null) {
      const file = /(?:^|,)file=([^,\]]+)/.exec(m[0])?.[1] ?? ''
      const url = /(?:^|,)url=([^,\]]+)/.exec(m[0])?.[1] ?? ''
      images.push({ file: cqUnescape(file), url: cqUnescape(url) })
    }
    text = raw
      .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
      // QQ 表情：能识别出名字就写 [表情:名字]，否则退回占位符
      .replace(/\[CQ:face[^\]]*\]/g, (whole) => {
        const id = /(?:^|,)id=(\d+)/.exec(whole)?.[1] ?? ''
        const name = faceName(id)
        return name ? `[表情:${name}]` : '[表情]'
      })
      .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
      .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
      .replace(/\[CQ:at,qq=(\d+)[^\]]*\]/g, (m, qq) => (qq === self ? '' : qq === 'all' ? '[@全体]' : `[@${qq}]`))
      .replace(/\[CQ:reply[^\]]*\]/g, '')
      .replace(/\[CQ:(?:forward|node),[^\]]*\]/g, '[合并聊天记录]')
      .replace(/\[CQ:json,[^\]]*\]/g, whole => forwardSegments(whole).length ? '[合并聊天记录]' : '')
      .replace(/\[CQ:[^\]]*\]/g, '')
      .trim()
  } else if (Array.isArray(raw)) {
    const parts = []
    for (const seg of raw) {
      if (!seg || typeof seg !== 'object') continue
      const data = seg.data || {}
      switch (seg.type) {
        case 'text':
          parts.push(String(data.text ?? ''))
          break
        case 'image':
          parts.push('[图片]')
          images.push({ file: String(data.file ?? ''), url: String(data.url ?? '') })
          break
        case 'face': {
          // NapCat 对新版表情会给 raw.faceText（如 "/知识增加"）；经典小黄脸只有 id
          const name = faceName(data.id, data.raw?.faceText)
          parts.push(name ? `[表情:${name}]` : '[表情]')
          break
        }
        case 'record':
          parts.push('[语音]')
          break
        case 'video':
          parts.push('[视频]')
          break
        case 'at': {
          const qq = String(data.qq ?? '')
          if (qq === self) atBot = true
          else if (qq && qq !== 'all') parts.push(`[@${qq}]`)
          break
        }
        case 'reply':
          // 引用消息：记下被引用消息的 id，稍后由上层取回原文
          replyId = String(data.id ?? '')
          break
        case 'forward':
        case 'node':
          parts.push('[合并聊天记录]')
          break
        case 'json':
          if (forwardSegments([seg]).length) parts.push('[合并聊天记录]')
          break
        default:
          break
      }
    }
    text = preserveNewlines
      ? parts.join(' ').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim()
      : parts.join(' ').replace(/\s+/g, ' ').trim()
  }

  return { text, atBot, images, replyId, forwards }
}
