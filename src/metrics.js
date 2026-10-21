import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const DAY = 86400000
const FIELDS = ['received', 'replied', 'skipped', 'errors', 'stickers', 'searches', 'llmMs', 'llmCount']

/** 轻量指标：按天累计消息、回复、跳过、错误、表情包、搜索与耗时，30 秒批量落盘。 */
export function createMetrics({ file, now = () => Date.now(), logger }) {
  let data = { days: {} }
  try { if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) || { days: {} } } catch {}
  if (!data.days || typeof data.days !== 'object') data.days = {}
  let dirty = false
  let timer = null
  const pad = (n) => String(n).padStart(2, '0')
  const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
  function save() {
    if (!dirty) return
    try { writeFileSync(file, JSON.stringify(data)); dirty = false } catch (err) { logger?.warn?.('指标保存失败：' + err.message) }
  }
  function schedule() {
    if (timer) return
    timer = setTimeout(() => { timer = null; save() }, 30000)
    timer.unref?.()
  }
  function prune() {
    const keys = Object.keys(data.days).sort()
    if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete data.days[k]
  }
  function bump(field, amount = 1) {
    const k = dayKey(now())
    const day = data.days[k] || (data.days[k] = {})
    day[field] = (Number(day[field]) || 0) + amount
    dirty = true; schedule(); prune()
  }
  function snapshot(days = 7) {
    const out = []
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(now() - i * DAY)
      const d = data.days[k] || {}
      const row = { date: k }
      for (const f of FIELDS) row[f] = Number(d[f]) || 0
      out.push(row)
    }
    return out
  }
  return {
    received: () => bump('received'),
    replied: () => bump('replied'),
    skipped: () => bump('skipped'),
    error: () => bump('errors'),
    sticker: () => bump('stickers'),
    search: () => bump('searches'),
    llm: (ms) => { bump('llmMs', Math.max(0, Math.round(Number(ms) || 0))); bump('llmCount') },
    snapshot, flush: save,
  }
}
