import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const validTime = value => Number.isFinite(value) && value > 0 && value <= 8.64e15
const validReplyLength = value => Number.isFinite(value) && value >= 0
// QQ 发送时间精度为秒；同一秒内按接收/插入顺序保持问答关系。
const chronological = (a, b) => Math.floor((a.time || 0) / 1000) - Math.floor((b.time || 0) / 1000)

// 可选的归属信息与正文分开保存；旧记忆没有时不猜测回复对象。
function conversationMeta(meta) {
  const out = {}
  for (const key of ['userId', 'replyToUserId', 'replyToMessageId']) {
    if (typeof meta[key] === 'string' || typeof meta[key] === 'number') {
      const value = String(meta[key])
      if (/^-?\d{1,24}$/.test(value)) out[key] = value
    }
  }
  for (const key of ['senderName', 'replyToName']) {
    if (typeof meta[key] === 'string') {
      const value = meta[key].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
      if (value) out[key] = value
    }
  }
  return out
}

function speaker(name, id) {
  return [name ? JSON.stringify(name) : '', id ? `用户标识 ${id}` : ''].filter(Boolean).join('，')
}

/** API 只接收 role/content；时间作为阅读提示，不泄露内部元数据字段。 */
export function modelHistory(list) {
  return list.map((m) => {
    const meta = conversationMeta(m)
    const author = speaker(meta.senderName, meta.userId)
    const recipient = speaker(meta.replyToName, meta.replyToUserId)
    return { role: m.role, content: m.role === 'user'
      ? `【${m.historical ? '登录补读；' : ''}历史消息 ${validTime(m.time) ? new Date(m.time).toISOString() : '时间未知'}${author ? `；发言者 ${author}` : ''}】${m.content}`
      : m.role === 'assistant' && recipient ? `【此前回复对象：${recipient}】${m.content}` : m.content }
  })
}

/**
 * 每个会话（私聊按人、群聊按群）保留最近 N 条对话，
 * 防抖持久化到 data/memory.json，重启后仍记得聊过什么。
 */
export class MemoryStore {
  constructor({ file, limit, logger }) {
    this.file = file
    this.limit = limit
    this.logger = logger
    this.chats = new Map()
    this.dirty = false
    this.timer = null
  }

  load() {
    try {
      if (!existsSync(this.file)) return
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (data && typeof data === 'object') {
        for (const [key, list] of Object.entries(data)) {
          if (Array.isArray(list)) {
            const items = list
              .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
              .slice(-this.limit)
              .map((m) => ({ role: m.role, content: m.content,
                time: validTime(m.time) ? m.time : null,
                ...(m.historical ? { historical: true } : {}),
                ...(validReplyLength(m.replyLength) ? { replyLength: m.replyLength } : {}),
                ...(m.messageId ? { messageId: String(m.messageId) } : {}), ...conversationMeta(m) }))
              .sort(chronological)
            if (items.length > 0) this.chats.set(key, items)
          }
        }
      }
      this.logger.info(`已载入 ${this.chats.size} 个会话的历史记忆`)
    } catch (err) {
      this.logger.warn(`读取记忆文件失败，将以空记忆开始：${err.message}`)
    }
  }

  get(key) {
    let list = this.chats.get(key)
    if (!list) {
      list = []
      this.chats.set(key, list)
    }
    return list
  }

  push(key, role, content, meta = {}) {
    const list = this.get(key)
    const messageId = meta.messageId == null ? '' : String(meta.messageId)
    if (messageId && list.some(m => m.role === role && m.messageId === messageId)) return false
    const time = meta.time === null ? null : validTime(meta.time) ? meta.time : Date.now()
    list.push({ role, content, time, ...(meta.historical ? { historical: true } : {}),
      ...(validReplyLength(meta.replyLength) ? { replyLength: meta.replyLength } : {}), ...(messageId ? { messageId } : {}),
      ...conversationMeta(meta) })
    list.sort(chronological)
    const evicted = []
    while (list.length > this.limit) {
      const old = list.shift()
      if (old && old.role === 'user') evicted.push({ content: old.content, time: old.time })
    }
    this.dirty = true
    this.#scheduleSave()
    // 被挤出去的旧消息交给长期记忆（压缩成摘要），而不是直接丢掉
    if (evicted.length > 0 && typeof this.onEvict === 'function') {
      try {
        this.onEvict(key, evicted)
      } catch {
        /* 长期记忆失败不影响主流程 */
      }
    }
    return true
  }

  #scheduleSave() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 2000)
    if (this.timer.unref) this.timer.unref()
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const obj = {}
      for (const [key, list] of this.chats) obj[key] = list
      writeFileSync(this.file, JSON.stringify(obj, null, 2))
    } catch (err) {
      this.logger.warn(`保存记忆失败：${err.message}`)
    }
  }
}
