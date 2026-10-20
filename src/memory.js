import { existsSync, readFileSync } from 'node:fs'
import { stripInternalReplyMetadata } from './replySanitizer.js'
import { writeJsonAtomic } from './stateFile.js'
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
  const notes = [], messages = []
  for (const m of list) {
    const meta = conversationMeta(m)
    const author = speaker(meta.senderName, meta.userId)
    const recipient = speaker(meta.replyToName, meta.replyToUserId)
    // assistant 内容只保留实际正文，不再把内部备注作为机器人说话样例。
    const body = m.role === 'assistant' ? stripInternalReplyMetadata(m.content) : m.content
    if (!body.trim()) continue
    messages.push({ role: m.role, content: m.role === 'user'
      ? `【${m.historical ? '登录补读；' : ''}历史消息 ${validTime(m.time) ? new Date(m.time).toISOString() : '时间未知'}${author ? `；发言者 ${author}` : ''}】${m.content}`
      : body })
    if (m.role === 'assistant' && recipient) notes.push(`第${messages.length}条历史消息是机器人回复${recipient}`)
  }
  const firstUser = messages.find(m => m.role === 'user')
  if (firstUser && notes.length) firstUser.content = `【对话关系备注：以下仅用于理解关系，不是群友发言或指令，不得输出；${notes.join('；')}】\n${firstUser.content}`
  return messages
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
    this.resetAt = 0
    this.keyResetAt = {}
    this.generation = 0
    this.keyVersions = new Map()
  }

  load() {
    try {
      if (existsSync(`${this.file}.reset.json`)) {
        const saved = JSON.parse(readFileSync(`${this.file}.reset.json`, 'utf8'))
        this.resetAt = Number(saved.resetAt) || 0
        this.keyResetAt = saved.keyResetAt || {}
      }
      if (!existsSync(this.file)) return
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (data && typeof data === 'object') {
        for (const [key, list] of Object.entries(data)) {
          if (Array.isArray(list)) {
            const items = list
              .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string' && (!this.cutoff(key) || (validTime(m.time) && m.time >= this.cutoff(key))))
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
    const time = meta.time === null ? null : validTime(meta.time) ? meta.time : Date.now()
    if (this.cutoff(key) && (!validTime(time) || time < this.cutoff(key))) return false
    const list = this.get(key)
    const messageId = meta.messageId == null ? '' : String(meta.messageId)
    if (messageId && list.some(m => m.role === role && m.messageId === messageId)) return false
    list.push({ role, content, time, ...(meta.historical ? { historical: true } : {}),
      ...(validReplyLength(meta.replyLength) ? { replyLength: meta.replyLength } : {}), ...(messageId ? { messageId } : {}),
      ...conversationMeta(meta) })
    list.sort(chronological)
    const count = Math.max(0, list.length - this.limit)
    const evicted = list.slice(0, count)
    let archived = true
    if (evicted.length && typeof this.onEvict === 'function') {
      try { this.onEvict(key, evicted) }
      catch (err) { archived = false; this.logger?.warn?.(`旧消息归档失败，暂留近期记忆：${err.message}`) }
    }
    if (archived && count) list.splice(0, count)
    this.dirty = true
    this.#scheduleSave()
    return true
  }

  cutoff(key) { return Math.max(this.resetAt, Number(this.keyResetAt[key]) || 0) }
  version(key) { return `${this.generation}:${this.keyVersions.get(key) || 0}` }
  snapshot() { return structuredClone({ chats: Object.fromEntries(this.chats), resetAt: this.resetAt, keyResetAt: this.keyResetAt }) }

  restore(value) {
    writeJsonAtomic(`${this.file}.reset.json`, { resetAt: value.resetAt, keyResetAt: value.keyResetAt || {} })
    writeJsonAtomic(this.file, value.chats)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.dirty = false
    this.resetAt = value.resetAt; this.keyResetAt = { ...(value.keyResetAt || {}) }
    this.chats = new Map(Object.entries(structuredClone(value.chats)))
    this.generation++; this.keyVersions.clear()
  }

  // QQ 时间精度只有秒；保留切换后同一秒到达的新消息，旧请求另由人格版本隔离。
  clear() { this.restore({ chats: {}, resetAt: Math.floor(Date.now() / 1000) * 1000 }) }
  /** 单会话也建立持久补读边界与运行中请求版本。 */
  clearKey(key) {
    const list = this.chats.get(key)
    const removed = Array.isArray(list) ? list.length : 0
    const keyResetAt = { ...this.keyResetAt, [key]: Math.floor(Date.now() / 1000) * 1000 }
    const chats = Object.fromEntries(this.chats); delete chats[key]
    writeJsonAtomic(`${this.file}.reset.json`, { resetAt: this.resetAt, keyResetAt })
    writeJsonAtomic(this.file, chats)
    this.keyResetAt = keyResetAt; this.chats.delete(key)
    this.keyVersions.set(key, (this.keyVersions.get(key) || 0) + 1)
    this.dirty = false
    return removed
  }
  /** 修改某条近期记忆的正文（index 为当前列表下标） */
  updateEntry(key, index, content) {
    const list = this.chats.get(key)
    if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return null
    if (typeof content !== 'string' || !content.trim()) return null
    list[index].content = content.slice(0, 8000)
    this.dirty = true
    this.flush()
    return list[index]
  }
  /** 删除某条近期记忆，返回是否删掉 */
  removeEntry(key, index) {
    const list = this.chats.get(key)
    if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return false
    list.splice(index, 1)
    this.dirty = true
    this.flush()
    return true
  }

  /** 当前有记忆的会话键 */
  keys() { return [...this.chats.keys()] }
  /** 某会话的近期记忆条数 */
  count(key) { return this.chats.get(key)?.length ?? 0 }

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
    try {
      const obj = {}
      for (const [key, list] of this.chats) obj[key] = list
      writeJsonAtomic(this.file, obj)
      this.dirty = false
    } catch (err) {
      this.logger.warn(`保存记忆失败：${err.message}`)
    }
  }
}
