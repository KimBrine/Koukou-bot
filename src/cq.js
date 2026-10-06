/**
 * 解析 OneBot 11 消息（兼容 NapCat 的 string / array 两种消息格式）。
 * 返回 { text, atBot, images }：
 * - text：可读文本（QQ 表情转成 [表情:名字]，图片转为占位符）
 * - atBot：是否 @ 了机器人
 * - images：[{ file, url }] 消息里的图片/表情包（供视觉模型识图）
 */

import { faceName } from './qqFace.js'

function cqUnescape(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
}

export function parseMessage(raw, selfId) {
  const self = selfId == null ? '' : String(selfId)
  let text = ''
  let atBot = false
  let replyId = ''
  const images = []

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
        default:
          break
      }
    }
    text = parts.join(' ').replace(/\s+/g, ' ').trim()
  }

  return { text, atBot, images, replyId }
}
