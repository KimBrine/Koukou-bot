import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const DAY = 86400000

/** 轻量指标：每天记收到/回复条数，30 秒批量落盘一次。 */
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
  function bump(field) {
    const k = dayKey(now())
    const day = data.days[k] || (data.days[k] = { received: 0, replied: 0 })
    day[field] = (Number(day[field]) || 0) + 1
    dirty = true; schedule(); prune()
  }
  function snapshot(days = 7) {
    const out = []
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(now() - i * DAY)
      const d = data.days[k] || {}
      out.push({ date: k, received: Number(d.received) || 0, replied: Number(d.replied) || 0 })
    }
    return out
  }
  return { received: () => bump('received'), replied: () => bump('replied'), snapshot, flush: save }
}
