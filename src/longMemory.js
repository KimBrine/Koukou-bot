import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 长期记忆：把从近期窗口里"挤出去"的旧消息，压缩成一段可持续增长的记忆摘要。
 * - 每条会话（群/私聊）各有一份摘要，随对话不断累积、合并、去芜存菁；
 * - 摘要会注入到每次回复的系统提示里，所以机器人"记得"的东西远超近期窗口；
 * - 压缩用便宜模型（qwen flash），失败不丢数据（批次会放回队列下次再试）。
 */
export function createLongMemory({ file, logger, llm, maxChars = 1500, intervalMs = 10 * 60 * 1000, maxBatch = 60 }) {
  const store = new Map() // key -> { summary: string, pending: [{name,text,time}], updatedAt: number }
  let timer = null

  function load() {
    try {
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf8'))
      for (const [key, value] of Object.entries(data || {})) {
        if (value && typeof value === 'object') {
          store.set(key, {
            summary: String(value.summary || ''),
            pending: Array.isArray(value.pending) ? value.pending : [],
            updatedAt: Number(value.updatedAt) || 0,
          })
        }
      }
      if (store.size > 0) {
        const total = [...store.values()].reduce((n, v) => n + (v.summary ? v.summary.length : 0), 0)
        logger.info(`已载入长期记忆：${store.size} 个会话，共 ${total} 字`)
      }
    } catch (err) {
      logger.warn(`长期记忆读取失败：${err.message}`)
    }
  }

  function save() {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const out = {}
      for (const [key, value] of store) out[key] = value
      writeFileSync(file, JSON.stringify(out, null, 2))
    } catch (err) {
      logger.warn(`长期记忆保存失败：${err.message}`)
    }
  }

  function get(key) {
    return store.get(key)?.summary || ''
  }

  /** 接收被挤出近期窗口的旧消息 */
  function addEvicted(key, entries) {
    if (!entries || entries.length === 0) return
    const item = store.get(key) || { summary: '', pending: [], updatedAt: 0 }
    for (const e of entries) {
      const text = String(e?.content ?? e?.text ?? '').trim()
      if (!text) continue
      item.pending.push({ name: e.name || '', text: text.slice(0, 150), time: e.time || 0 })
    }
    store.set(key, item)
    save()
    if (item.pending.length >= maxBatch) {
      summarize(key).catch((err) => logger.warn(`长期记忆压缩失败：${err.message}`))
    }
  }

  /** 把待处理消息合并进摘要 */
  async function summarize(key) {
    const item = store.get(key)
    if (!item || item.pending.length === 0) return false
    const batch = item.pending.slice(0, maxBatch)
    const lines = batch
      .map((e) => (e.name ? `${e.name}：${e.text}` : e.text))
      .join('\n')
    const prompt = `你是群聊长期记忆的整理助手。下面给出【已有记忆】和【新增聊天记录】，请合并成一份更完整的长期记忆。

要求：
1. 保留：重要事件、人物关系与你对他们的印象（性格/口头禅/爱好）、持续的话题与梗、约定和结论、值得记住的信息；
2. 丢弃：寒暄、重复内容、无信息量的水聊；
3. 用第三人称客观陈述，不要标题、不要分点编号、不要评论；
4. 总长度控制在 ${maxChars} 字以内（超出时优先保留近期与重要内容）。`
    try {
      const merged = await llm.chat(prompt, [{ role: 'user', content: `【已有记忆】\n${item.summary || '（暂无）'}\n\n【新增聊天记录】\n${lines}` }])
      item.pending.splice(0, batch.length)
      item.summary = String(merged).replace(/\s+/g, ' ').trim().slice(0, maxChars)
      item.updatedAt = Date.now()
      store.set(key, item)
      save()
      logger.info(`长期记忆已更新（${key}）：摘要 ${item.summary.length} 字，剩余待处理 ${item.pending.length} 条`)
      return true
    } catch (err) {
      logger.warn(`长期记忆压缩失败（${key}）：${err.message}（${batch.length} 条将保留待重试）`)
      return false
    }
  }

  /** 外部批量投喂（用于历史回填） */
  async function feed(key, entries, { batchSize = 200 } = {}) {
    const item = store.get(key) || { summary: '', pending: [], updatedAt: 0 }
    store.set(key, item)
    for (let i = 0; i < entries.length; i += batchSize) {
      const chunk = entries.slice(i, i + batchSize)
      item.pending.push(...chunk.map((e) => ({ name: e.name || '', text: String(e.text ?? '').slice(0, 150), time: e.time || 0 })))
      while (item.pending.length > 0) {
        const ok = await summarize(key)
        if (!ok) return false
      }
    }
    return true
  }

  function start() {
    if (timer) return
    timer = setInterval(() => {
      for (const key of [...store.keys()]) {
        summarize(key).catch(() => {})
      }
    }, intervalMs)
    if (timer.unref) timer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function stats() {
    const out = []
    for (const [key, value] of store) {
      out.push({ key, summaryChars: value.summary.length, pending: value.pending.length })
    }
    return out
  }

  load()
  return { get, addEvicted, summarize, feed, start, stop, save, stats }
}
