import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** 最近错误环形缓冲，落盘到 data/errors.json，供控制台"错误中心"查看。 */
export function createErrorStore({ file, limit = 200, now = () => Date.now() }) {
  let items = []
  try { if (existsSync(file)) items = JSON.parse(readFileSync(file, 'utf8')) || [] } catch { items = [] }
  if (!Array.isArray(items)) items = []
  const save = () => { try { writeFileSync(file, JSON.stringify(items)) } catch {} }
  function add(message, scope = 'bot') {
    items.push({ time: now(), scope, message: String(message || '').slice(0, 4000) })
    if (items.length > limit) items = items.slice(-limit)
    save()
  }
  const list = () => items.slice().reverse()
  const clear = () => { items = []; save() }
  return { add, list, clear }
}
