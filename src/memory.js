import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
              .map((m) => ({ role: m.role, content: m.content }))
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

  push(key, role, content) {
    const list = this.get(key)
    list.push({ role, content })
    const evicted = []
    while (list.length > this.limit) {
      const old = list.shift()
      if (old && old.role === 'user') evicted.push({ content: old.content })
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
