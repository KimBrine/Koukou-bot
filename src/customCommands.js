import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { writeJsonAtomic } from './stateFile.js'

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
    args: String(ctx.args ?? ''),
  }
  return String(template ?? '').replace(/\{(name|qq|group|time|date|args)\}/g, (m, k) => (k in map ? map[k] : m))
}

export function commandScopeAllows(command, ctx = {}) {
  if (ctx.isPrivate) return command.scope !== 'group' && command.scope !== 'groups'
  return command.scope !== 'private' && (command.scope !== 'group' || command.groups?.map(Number).includes(Number(ctx.groupId)))
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
        list = data.slice(0, MAX).map(clean)
      }
      if (list.length > 0) logger?.info?.(`已载入 ${list.length} 条自定义指令`)
    } catch (err) {
      logger?.warn?.(`自定义指令读取失败：${err.message}`)
    }
  }

  function save(next = list) {
    writeJsonAtomic(file, next)
  }

  function clean(input = {}) {
    const match = ['exact', 'prefix', 'contains'].includes(input.match) ? input.match : 'exact'
    const scope = ['all', 'groups', 'group', 'private'].includes(input.scope) ? input.scope : 'all'
    const responseMode = input.responseMode || 'fixed'
    if (!['fixed','random','ai'].includes(responseMode)) throw Error('仅支持固定、随机或 AI 回复规则')
    const event = input.event || 'message'
    if (!['message','poke'].includes(event)) throw Error('不支持的触发事件')
    if (input.scheduleEnabled && (responseMode !== 'fixed' || event !== 'message')) throw Error('定时推送仅支持文字触发的固定回复规则')
    const groups = (Array.isArray(input.groups) ? input.groups : String(input.groups ?? '').split(','))
      .map((g) => Number(String(g).trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    // 定时推送：每天在指定时刻把这些群发一遍（不调用模型）
    const times = (Array.isArray(input.scheduleTimes) ? input.scheduleTimes : String(input.scheduleTimes ?? '').split(','))
      .map((s) => String(s).trim())
      .filter((s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(s))
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
      aliases: (Array.isArray(input.aliases) ? input.aliases : String(input.aliases || '').split(/[\n,，]/)).map(x=>String(x).trim().slice(0,100)).filter(Boolean).slice(0,20),
      event, responseMode,
      aiPrompt: String(input.aiPrompt || '').trim().slice(0,4000),
      description: String(input.description || '').trim().slice(0,800),
      naturalLanguage: responseMode === 'ai' && input.naturalLanguage === true,
      adminOnly: input.adminOnly === true,
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
    validate(cmd)
    const i = list.findIndex((c) => c.id === cmd.id)
    const next = [...list]
    if (i >= 0) next[i] = cmd
    else {
      if (list.length >= MAX) throw new Error(`最多 ${MAX} 条自定义指令`)
      next.push(cmd)
    }
    save(next)
    list = next
    return cmd
  }

  function remove(id) {
    const before = list.length
    const next = list.filter((c) => c.id !== String(id))
    if (next.length !== before) { save(next); list = next }
    return next.length !== before
  }

  function all() {
    return structuredClone(list)
  }

  function validate(cmd) {
    if (cmd.event !== 'poke' && !cmd.trigger) throw Error('触发词不能为空')
    if (cmd.responseMode === 'ai' ? !cmd.aiPrompt : !cmd.reply.trim()) throw Error(cmd.responseMode === 'ai' ? '请填写 AI 执行要求' : '回复内容不能为空')
    if (cmd.enabled && cmd.scope === 'group' && !cmd.groups.length) throw Error('请至少选择一个适用群聊')
    return cmd
  }
  function normalize(input) { return validate(clean(input)) }
  function replace(items) {
    if (!Array.isArray(items) || items.length > MAX) throw Error(`最多 ${MAX} 条自定义指令`)
    const next = items.map(normalize)
    if (new Set(next.map(c=>c.id)).size !== next.length) throw Error('指令标识重复')
    save(next); list = next; lastUsed.clear()
  }
  function literal(text, ctx = {}) {
    const t = String(text ?? '').trim()
    const candidates=list.filter(c => (c.event || 'message') === (ctx.event || 'message') && (c.event === 'poke' || [c.trigger,...(c.aliases||[])].filter(Boolean).some(k => c.match === 'prefix' ? t.startsWith(k) : c.match === 'contains' ? t.includes(k) : t === k)))
    return candidates.find(c=>c.enabled&&commandScopeAllows(c,ctx))||candidates.find(c=>commandScopeAllows(c,ctx))||candidates[0]||null
  }
  function claim(c,ctx={}) {
    const key=`${c.id}:${ctx.isPrivate?'p'+ctx.userId:'g'+ctx.groupId}`, now=Date.now()
    if (c.cooldownSec > 0 && now-(lastUsed.get(key)||0)<c.cooldownSec*1000) return false
    lastUsed.set(key,now); return true
  }

  /** 只列候选时点；是否送达由持久化调度器核对，不能在发送前占掉名额。 */
  function due(now = Date.now(), { windowMs = 5 * 60000 } = {}) {
    const out = [], seen = new Set(), today = new Date(now)
    for (const dayOffset of [-1, 0]) {
      for (const c of list) {
      if (!c.enabled || !c.scheduleEnabled || c.responseMode !== 'fixed') continue
        for (const time of c.scheduleTimes || []) {
          const [h, m] = time.split(':').map(Number)
          const date = new Date(today.getFullYear(), today.getMonth(), today.getDate()+dayOffset, h, m, 0, 0)
          const at = date.getTime()
          if (at > now || now-at >= windowMs) continue
          const day = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-')
          for (const groupId of c.scheduleGroups || []) {
            if(!commandScopeAllows(c,{isPrivate:false,groupId}))continue
            const slotKey = JSON.stringify([c.id, groupId, day, time])
            if (seen.has(slotKey)) continue
            seen.add(slotKey); out.push({ command: c, groupId, targetAt: at, slotKey })
          }
        }
      }
    }
    return out.sort((a,b)=>a.targetAt-b.targetAt)
  }

  /** 命中第一条启用的指令；ctx = { isPrivate, groupId, userId } */
  function match(text, ctx = {}) {
    const t = String(text ?? '').trim()
    if (!t) return null
    const isPrivate = Boolean(ctx.isPrivate)
    const groupId = Number(ctx.groupId) || 0
    for (const c of list) {
      if (!c.enabled) continue
      if (c.event !== 'message' || !commandScopeAllows(c,ctx)) continue
      let hit = false
      hit = [c.trigger,...(c.aliases||[])].some(k => c.match === 'prefix' ? t.startsWith(k) : c.match === 'contains' ? t.includes(k) : t === k)
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
  return { all, upsert, remove, match, due, load, save, file, normalize, replace, literal, claim }
}
