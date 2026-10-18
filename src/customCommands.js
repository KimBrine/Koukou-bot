import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * 自定义指令：在控制台里配「触发词 → 固定回复」，不调用模型、不花钱。
 *
 * 每条：
 *   { id, name, trigger, match: 'exact'|'prefix'|'contains', reply, enabled,
 *     scope: 'all'|'group'|'private', groups: number[], cooldownSec }
 *
 * 匹配顺序按列表顺序，先命中先回复；同一条指令在同一会话里有冷却时间。
 */
/**
 * 回复模板变量替换：{name} 发言人昵称、{qq} 发言人 QQ、{group} 群名、{time} 当前时间、{date} 今天日期
 * 未知变量原样保留，避免把 {xxx} 吞掉导致内容丢失。
 */
export function renderReply(template, ctx = {}) {
  const now = ctx.now ? new Date(ctx.now) : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const map = {
    name: String(ctx.name ?? '').trim() || '你',
    qq: String(ctx.userId ?? ''),
    group: String(ctx.groupName ?? ''),
    time: now.toLocaleString('zh-CN', { hour12: false }),
    date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
  }
  return String(template ?? '').replace(/\{(name|qq|group|time|date)\}/g, (m, k) => (k in map ? map[k] : m))
}

export function createCustomCommands({ file, logger }) {
  let list = []
  const lastUsed = new Map()
  const MAX = 200

  function load() {
    try {
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(data)) {
        list = data.filter((c) => c && typeof c.trigger === 'string' && typeof c.reply === 'string').slice(0, MAX)
      }
      if (list.length > 0) logger?.info?.(`已载入 ${list.length} 条自定义指令`)
    } catch (err) {
      logger?.warn?.(`自定义指令读取失败：${err.message}`)
    }
  }

  function save() {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(list, null, 2))
    } catch (err) {
      logger?.warn?.(`自定义指令保存失败：${err.message}`)
    }
  }

  function clean(input = {}) {
    const match = ['exact', 'prefix', 'contains'].includes(input.match) ? input.match : 'exact'
    const scope = ['all', 'group', 'private'].includes(input.scope) ? input.scope : 'all'
    const groups = (Array.isArray(input.groups) ? input.groups : String(input.groups ?? '').split(','))
      .map((g) => Number(String(g).trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    // 定时推送：每天在指定时刻把这些群发一遍（不调用模型）
    const times = (Array.isArray(input.scheduleTimes) ? input.scheduleTimes : String(input.scheduleTimes ?? '').split(','))
      .map((s) => String(s).trim())
      .filter((s) => /^\d{1,2}:\d{2}$/.test(s))
      .map((s) => {
        const [h, m] = s.split(':')
        return String(Math.min(23, Math.max(0, Number(h)))).padStart(2, '0') + ':' + String(Math.min(59, Math.max(0, Number(m)))).padStart(2, '0')
      })
      .slice(0, 10)
    const scheduleGroups = (Array.isArray(input.scheduleGroups) ? input.scheduleGroups : String(input.scheduleGroups ?? '').split(','))
      .map((g) => Number(String(g).trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 20)
    return {
      id: String(input.id || randomBytes(4).toString('hex')),
      name: String(input.name ?? '').trim().slice(0, 40) || '未命名指令',
      trigger: String(input.trigger ?? '').trim().slice(0, 100),
      match,
      reply: String(input.reply ?? '').slice(0, 4000),
      enabled: input.enabled !== false,
      scope,
      groups,
      cooldownSec: Math.max(0, Math.min(86400, Number(input.cooldownSec) || 0)),
      scheduleEnabled: input.scheduleEnabled === true,
      scheduleTimes: times,
      scheduleGroups,

    }
  }

  function upsert(input = {}) {
    const cmd = clean(input)
    if (!cmd.trigger) throw new Error('触发词不能为空')
    if (!cmd.reply.trim()) throw new Error('回复内容不能为空')
    const i = list.findIndex((c) => c.id === cmd.id)
    if (i >= 0) list[i] = cmd
    else {
      if (list.length >= MAX) throw new Error(`最多 ${MAX} 条自定义指令`)
      list.push(cmd)
    }
    save()
    return cmd
  }

  function remove(id) {
    const before = list.length
    list = list.filter((c) => c.id !== String(id))
    if (list.length !== before) save()
    return list.length !== before
  }

  function all() {
    return list.map((c) => ({ ...c, groups: [...(c.groups || [])] }))
  }

  const sentSlots = new Map() // 'id:群号:HH:MM:日期' -> true，同一个时间点只发一次

  /**
   * 当前这一分钟该发哪些定时推送。
   * 返回 [{ command, groupId }]；同一分钟的重复调用不会重复返回。
   */
  function due(now = Date.now()) {
    const d = new Date(now)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const slot = hh + ':' + mm
    const day = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
    const out = []
    for (const c of list) {
      if (!c.enabled || !c.scheduleEnabled) continue
      if (!Array.isArray(c.scheduleTimes) || !c.scheduleTimes.includes(slot)) continue
      for (const gid of c.scheduleGroups || []) {
        const key = c.id + ':' + gid + ':' + slot + ':' + day
        if (sentSlots.has(key)) continue
        sentSlots.set(key, true)
        out.push({ command: c, groupId: gid })
      }
    }
    // 只保留最近一天的记录，避免无限增长
    if (sentSlots.size > 2000) {
      const keep = new Set()
      for (const k of sentSlots.keys()) {
        if (k.endsWith(day)) keep.add(k)
      }
      sentSlots.clear()
      for (const k of keep) sentSlots.set(k, true)
    }
    return out
  }

  /** 命中第一条启用的指令；ctx = { isPrivate, groupId, userId } */
  function match(text, ctx = {}) {
    const t = String(text ?? '').trim()
    if (!t) return null
    const isPrivate = Boolean(ctx.isPrivate)
    const groupId = Number(ctx.groupId) || 0
    for (const c of list) {
      if (!c.enabled) continue
      if (c.scope === 'group' && (isPrivate || !(c.groups || []).includes(groupId))) continue
      if (c.scope === 'private' && !isPrivate) continue
      let hit = false
      if (c.match === 'prefix') hit = t.startsWith(c.trigger)
      else if (c.match === 'contains') hit = t.includes(c.trigger)
      else hit = t === c.trigger
      if (!hit) continue
      const key = `${c.id}:${isPrivate ? 'p' + (ctx.userId ?? '') : 'g' + groupId}`
      const cd = Math.max(0, Number(c.cooldownSec) || 0) * 1000
      if (cd > 0 && Date.now() - (lastUsed.get(key) || 0) < cd) continue
      lastUsed.set(key, Date.now())
      return c
    }
    return null
  }

  load()
  return { all, upsert, remove, match, due, load, save, file }
}
