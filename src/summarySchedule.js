import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseMessage } from './cq.js'
import { formatReportDate } from './summaryStats.js'

const pad = n => String(n).padStart(2, '0')
const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const targetAt = (day, time) => new Date(`${day}T${time}:00+08:00`).getTime()
const chinaDate = time => new Date(new Date(time).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
const chinaDay = time => dateKey(chinaDate(time))

export const ambiguousSummarySend = err => err?.code === 'SUMMARY_SEND_UNCERTAIN' || /超时|timeout|连接已断开|WebSocket|socket|ECONNRESET/i.test(String(err?.message ?? ''))

/** 23:30 只补确定未发过的群。回执落盘，历史不完整或发送结果不明确时保守跳过。 */
export function createSummarySchedule({ config, logger, onebot, groups, runGroup, isRunning, readEveningHistory, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const timers = new Set()
  const planned = new Set()
  const file = config.dataDir ? path.join(config.dataDir, 'summary-delivery-state.json') : null
  let state = { version: 1, deliveries: {}, slots: {} }
  let scheduled = false
  const enabled = () => config.summaryFallbackEnabled === true
  const configuredTimes = () => [...new Set((config.summaryTimes?.length ? config.summaryTimes : ['23:00'])
    .filter(time => /^([01]?\d|2[0-3]):[0-5]\d$/.test(time))
    .map(time => { const [hh, mm] = time.split(':'); return `${pad(hh)}:${mm}` }))]
  const deliveryKey = (day, groupId) => `${day}:${Number(groupId)}`
  const log = message => logger.info(`[总结补发] ${message}`)

  try {
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (saved.version !== 1 || !saved.deliveries || !saved.slots) throw Error('记录格式不正确')
      state = saved
    }
  } catch (err) { logger.warn(`[总结补发] 发送记录读取失败，将以 QQ 历史核验：${err.message}`) }

  function save() {
    if (!file) return
    // 只保留最近 14 天的状态，不保存报告内容。
    const cutoff = chinaDay(now() - 14 * 86400000)
    for (const map of [state.deliveries, state.slots]) {
      for (const key of Object.keys(map)) if (key.slice(0, 10) < cutoff) delete map[key]
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(state))
    renameSync(`${file}.tmp`, file)
  }

  async function online() {
    try {
      const health = await onebot.refreshStatus({ maxAgeMs: 0, forceProbe: true })
      return health.online === true && health.connected === true
    } catch (err) {
      logger.warn(`[定时总结] QQ 实际连接核验失败：${err.message}`)
      return false
    }
  }

  function hasDelivered(day, groupId) {
    return Number(state.deliveries[deliveryKey(day, groupId)]?.confirmed) > 0
  }

  function beforeSend(groupId) {
    if (!enabled() || chinaDate(now()).getHours() < 23) return null
    const key = deliveryKey(chinaDay(now()), groupId)
    const entry = state.deliveries[key] ?? { confirmed: 0, receiptIds: [] }
    entry.attemptedAt = now()
    entry.pending = true
    state.deliveries[key] = entry
    // 先落盘再调用 QQ；重启后能识别有过未确认的发送尝试。
    try { save() } catch (cause) {
      const err = Error(`报告发送意图保存失败：${cause.message}`)
      err.code = 'SUMMARY_SEND_UNCERTAIN'
      throw err
    }
    return key
  }

  function acknowledged(key, result) {
    if (!key) return
    const id = String(result?.message_id ?? '')
    if (!/^-?\d+$/.test(id) || id === '0') {
      const err = Error('QQ 未返回有效的报告消息编号，发送结果待历史核验')
      err.code = 'SUMMARY_SEND_UNCERTAIN'
      throw err
    }
    const entry = state.deliveries[key]
    entry.confirmed++
    entry.receiptIds = [...new Set([...entry.receiptIds, id])].slice(-100)
    entry.pending = false
    entry.sentAt = now()
    try { save() } catch (cause) {
      const err = Error(`报告回执保存失败：${cause.message}`)
      err.code = 'SUMMARY_SEND_UNCERTAIN'
      throw err
    }
  }

  function failed(key, err) {
    if (!key) return
    const entry = state.deliveries[key]
    entry.pending = false
    entry.uncertain = ambiguousSummarySend(err)
    try { save() } catch (cause) { logger.warn(`[总结补发] 未确认记录保存失败：${cause.message}`) }
  }

  async function inspectContent(raw, day, depth = 0, seen = new Set()) {
    if (depth > 6 || (typeof raw !== 'string' && !Array.isArray(raw)) || (Array.isArray(raw) && !raw.length)) return 'unknown'
    const text = parseMessage(raw, null).text
    if (text.includes('群聊日常分析报告') && (text.includes(formatReportDate(day)) || text.includes(day))) return 'sent'
    let uncertain = /📊\s*基础统计|💬\s*热门话题|🏆\s*群友称号|💬\s*群圣经/.test(text)
    const list = Array.isArray(raw) ? raw : []
    if (list.some(segment => ['json', 'xml', 'markdown', 'node'].includes(segment?.type))) uncertain = true
    const forwards = list.filter(segment => segment?.type === 'forward')
    if (typeof raw === 'string') {
      for (const match of raw.matchAll(/\[CQ:forward,id=([^,\]]+)/g)) forwards.push({ data: { id: match[1] } })
    }
    for (const segment of forwards) {
      let nodes = segment.data?.content
      if (!Array.isArray(nodes)) {
        const id = String(segment.data?.id ?? '')
        if (!id || seen.has(id)) { uncertain = true; continue }
        seen.add(id)
        try { nodes = (await onebot.getForwardMsg(id, 15000))?.messages } catch { uncertain = true; continue }
      }
      if (!Array.isArray(nodes) || !nodes.length) { uncertain = true; continue }
      for (const node of nodes) {
        const result = await inspectContent(node.message ?? node.content ?? node.data?.content ?? node.data?.message, day, depth + 1, seen)
        if (result === 'sent') return 'sent'
        if (result === 'unknown') uncertain = true
      }
    }
    return uncertain ? 'unknown' : 'absent'
  }

  async function verifyNotSent(groupId, day) {
    if (hasDelivered(day, groupId)) return false
    if (!onebot.selfId) { log(`群 ${groupId} 未确认 QQ 账号，跳过`); return false }
    try {
      const history = await readEveningHistory(groupId, targetAt(day, '23:00') / 1000 - 15)
      if (!Array.isArray(history.rawMessages)) { log(`群 ${groupId} 未返回可核验的原始历史，跳过补发`); return false }
      let uncertain = false
      for (const msg of history.rawMessages ?? []) {
        if (String(msg.user_id) !== String(onebot.selfId) || Number(msg.time) < targetAt(day, '23:00') / 1000 - 15) continue
        const result = await inspectContent(msg.message ?? msg.raw_message, day)
        if (result === 'sent') {
          const key = deliveryKey(day, groupId)
          state.deliveries[key] = { ...state.deliveries[key], confirmed: 1, receiptIds: [String(msg.message_id)], sentAt: Number(msg.time) * 1000, verifiedFromHistory: true }
          save()
          log(`群 ${groupId} 已在 QQ 历史确认当晚报告，取消补发`)
          return false
        }
        if (result === 'unknown') uncertain = true
      }
      if (!history.complete || uncertain) { log(`群 ${groupId} 历史或转发内容未核验完整，无法确定未发送，跳过补发`); return false }
      const entry = state.deliveries[deliveryKey(day, groupId)]
      if (entry?.pending || entry?.uncertain) {
        // 本地超时不会撤销 NapCat 正在处理的发送；暂无历史也不能排除稍后送达。
        log(`群 ${groupId} 有未确认的发送尝试，无法排除稍后送达，跳过补发`)
        return false
      }
      return true
    } catch (err) {
      log(`群 ${groupId} 无法核验是否已发送，跳过补发：${err.message}`)
      return false
    }
  }

  async function runSlot(time, day = chinaDay(now())) {
    if (!config.summaryEnabled || chinaDay(now()) !== day) return
    const fallback = enabled() && time === '23:30'
    if (fallback && !configuredTimes().includes('23:00')) return
    const slot = `${day}:${time}`
    if (state.slots[slot]) return
    if (enabled()) { state.slots[slot] = { checkedAt: now() }; save() }
    if (!(await online())) {
      logger.info(`[定时总结] ${day} ${time} QQ 未登录或实际连接未确认，跳过；不在恢复登录后追补`)
      return
    }
    const targets = [...new Set(groups().map(Number))]
    if (!fallback) for (const id of targets) planned.add(deliveryKey(day, id))
    try {
      for (const [index, id] of targets.entries()) {
        const key = deliveryKey(day, id)
        try {
          if (enabled() && (hasDelivered(day, id) || (fallback && planned.has(key)))) {
            log(`群 ${id} 已发送报告或 23:00 任务仍在执行，跳过 ${time}`)
            continue
          }
          if (isRunning(id)) { log(`群 ${id} 正在生成，跳过 ${time}`); continue }
          if (fallback && !(await verifyNotSent(id, day))) continue
          if (hasDelivered(day, id)) continue
          if (chinaDay(now()) !== day) break
          if (!(await online())) { log(`QQ 已掉线，停止 ${time} 后续群的任务`); break }
          if (fallback) log(`群 ${id} 已确认当晚未发送，开始唯一一次 23:30 补发`)
          await runGroup(id, { scheduled: true, scheduleDay: day, scheduleTime: time })
          if (index + 1 < targets.length) await pause(5000)
        } catch (err) { logger.error(`[定时总结] 群 ${id} ${time} 任务失败：${err.message}`) }
        finally { if (!fallback) planned.delete(key) }
      }
    } finally {
      if (!fallback) for (const id of targets) planned.delete(deliveryKey(day, id))
    }
  }

  function arm(time) {
    const day = chinaDay(now())
    let target = targetAt(day, time)
    if (target <= now()) target += 86400000
    const targetDay = chinaDay(target)
    const wait = () => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (now() < target) { wait(); return }
        arm(time)
        if (chinaDay(now()) !== targetDay || now() - target >= 60000) {
          logger.info(`[定时总结] 已错过 ${targetDay} ${time} 检查时点，不追补`)
          return
        }
        runSlot(time, targetDay).catch(err => logger.error(`[定时总结] ${time} 检查失败：${err.message}`))
      }, Math.max(0, target - now()))
      timer.unref?.()
      timers.add(timer)
    }
    wait()
  }

  function schedule() {
    if (scheduled || !config.summaryEnabled) return
    scheduled = true
    const times = configuredTimes()
    if (enabled() && times.includes('23:00') && !times.includes('23:30')) times.push('23:30')
    for (const time of times) { arm(time); logger.info(`[定时总结] 每天 ${time}${enabled() && time === '23:30' ? ' 仅查漏补发（确认未发且 QQ 在线）' : ' 正常生成'}；错过不追补`) }
  }

  function stop() { for (const timer of timers) clearTimeout(timer); timers.clear(); scheduled = false }
  return { schedule, stop, runSlot, online, beforeSend, acknowledged, failed, hasDelivered, verifyNotSent }
}
