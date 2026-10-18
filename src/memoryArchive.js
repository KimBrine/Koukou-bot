import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

// 原文持久留存；检索只扫描有限的近期索引，不把整个档案塞进提示词。
export function createMemoryArchive(root) {
  const indexes = new Map()
  const limit = 3000
  function location(epoch, key) {
    if (!/^[a-zA-Z0-9-]+$/.test(epoch)) throw new Error('无效记忆分区')
    return path.join(root, epoch, createHash('sha256').update(key).digest('hex') + '.jsonl')
  }
  function index(epoch, key) {
    const id = `${epoch}:${key}`
    if (indexes.has(id)) return indexes.get(id)
    const file = location(epoch, key), entries = []
    if (existsSync(file)) {
      const size = statSync(file).size, start = Math.max(0, size - 4 * 1024 * 1024)
      const fd = openSync(file, 'r')
      let text
      try { const buf = Buffer.alloc(size - start); const n = readSync(fd, buf, 0, buf.length, start); text = buf.subarray(0, n).toString('utf8') }
      finally { closeSync(fd) }
      const lines = text.split('\n'); if (start) lines.shift()
      for (const line of lines) { try { const e = JSON.parse(line); if (typeof e.text === 'string') entries.push(e) } catch {} }
    }
    const out = entries.slice(-limit); indexes.set(id, out); return out
  }
  function add(epoch, key, entries) {
    const list = index(epoch, key), known = new Set(list.map(e => e.id)), batch = []
    for (const entry of entries) {
      const text = String(entry.content ?? entry.text ?? '').trim()
      if (!text) continue
      const role = entry.role || 'user', time = Number(entry.time) || 0
      const id = createHash('sha256').update(JSON.stringify([role, entry.messageId || '', time, text])).digest('hex')
      if (known.has(id)) continue
      known.add(id)
      batch.push({ id, role, text, time, name: entry.senderName || entry.name || '', userId: entry.userId || '' })
    }
    if (!batch.length) return
    const file = location(epoch, key); mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, batch.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    list.push(...batch); if (list.length > limit) list.splice(0, list.length - limit)
  }
  function retrieve(epoch, key, query, maxChars = 1400) {
    const normalized = String(query || '').slice(0, 500).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if (normalized.length < 3) return ''
    const grams = new Set(Array.from({ length: normalized.length - 1 }, (_, i) => normalized.slice(i, i + 2)))
    const hits = index(epoch, key).filter(e => e.role === 'user').map(e => {
      const text = e.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      const score = [...grams].filter(g => text.includes(g)).length
      return { e, score }
    }).filter(h => h.score >= 2).sort((a, b) => b.score - a.score || b.e.time - a.e.time).slice(0, 4)
    const lines = []; let remaining = maxChars
    for (const { e } of hits) {
      const header = `[${e.time ? new Date(e.time).toISOString() : '旧记录'}${e.name ? ` ${e.name}` : ''}] `
      const line = header + e.text
      if (line.length > remaining) continue // 不把残缺的数字、约定或句子当作完整事实。
      lines.push(line); remaining -= line.length + 1
    }
    return lines.join('\n')
  }
  /** 删掉某个会话在当前分区的原文档案（/清除记忆 用） */
  function drop(epochArg, key) {
    try { rmSync(location(epochArg, key), { force: true }); indexes.delete(`${epochArg}:${key}`); return true } catch { return false }
  }

return { add, retrieve, drop }
}
