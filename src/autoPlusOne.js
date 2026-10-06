import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const unescapeCq = value => String(value ?? '')
  .replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')

function segments(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return []
  const out = []
  let end = 0
  for (const match of raw.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > end) out.push({ type: 'text', data: { text: unescapeCq(raw.slice(end, match.index)) } })
    const data = {}
    for (const field of match[2].slice(1).split(',')) {
      const at = field.indexOf('=')
      if (at > 0) data[field.slice(0, at)] = unescapeCq(field.slice(at + 1))
    }
    out.push({ type: match[1], data })
    end = match.index + match[0].length
  }
  if (end < raw.length) out.push({ type: 'text', data: { text: unescapeCq(raw.slice(end)) } })
  return out
}

/** 只允许纯文字，保留原始空白和换行；非文字段会打断复读链。 */
export function plusOneFingerprint(raw) {
  const parts = []
  let text = ''
  for (const segment of segments(raw)) {
    const data = segment?.data ?? {}
    if (segment?.type === 'text') {
      const value = String(data.text ?? '')
      text += value
      if (!value) continue
      if (parts.at(-1)?.[0] === 'text') parts.at(-1)[1] += value
      else parts.push(['text', value])
    } else {
      // 图片、QQ 表情、@、引用等均不跟读，文字与它们混合也不跟读。
      return null
    }
  }
  if (!parts.length || !text.trim()) return null
  if (/^\s*[\/／]/.test(text) || /^\s*(?:今日总结|每日总结|群总结|群聊总结)\s*(?:d\s*)?\d{0,2}\s*[。！!~～]?\s*$/i.test(text)) return null
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** 每群一个连续复读段；预留发送机会在 await 前完成，重连/重启也保留去重状态。 */
export function createAutoPlusOne({ config, onebot, logger, onSent, now = Date.now }) {
  const groups = new Map()
  const seen = new Map()
  const file = config.dataDir ? path.join(config.dataDir, 'auto-plus-one.json') : null
  let saveTimer = null
  let dirty = false
  const active = id => config.autoPlusOneEnabled === true && config.whitelistGroups?.has(Number(id))

  function flush() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    if (!dirty || !file) return
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, groups: [...groups] }))
      renameSync(`${file}.tmp`, file)
      dirty = false
    } catch (err) { logger?.warn?.(`[自动+1] 去重状态保存失败：${err.message}`) }
  }

  function save(immediate = false) {
    dirty = true
    if (!file) return
    if (immediate) flush()
    else if (!saveTimer) saveTimer = setTimeout(flush, 200).unref()
  }

  try {
    if (file && existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      if (stored.version === 1 && Array.isArray(stored.groups)) {
        for (const [id, state] of stored.groups.slice(-1000)) {
          if (!/^\d+$/.test(String(id)) || !state || (state.hash !== null && !/^[a-f0-9]{64}$/.test(state.hash)) || !Number.isFinite(state.updatedAt)) continue
          groups.set(Number(id), { hash: state.hash, count: 0, fired: state.fired === true, lastId: String(state.lastId ?? ''),
            seq: /^\d+$/.test(String(state.seq ?? '')) ? String(state.seq) : null, updatedAt: state.updatedAt })
          // 重启后的第一条不能与停机前一条凑成两条；已跟过的相同连续段仍只跟一次。
        }
      }
    }
  } catch (err) { logger?.warn?.(`[自动+1] 去重状态读取失败：${err.message}`) }

  function observe(evt) {
    if (evt?.message_type !== 'group' || !evt.group_id) return {}
    const groupId = Number(evt.group_id)
    if (!active(groupId)) {
      if (groups.delete(groupId)) save()
      seen.delete(groupId)
      return {}
    }
    const selfId = String(onebot.selfId || evt.self_id || '')
    const own = evt.post_type === 'message_sent' || evt.message_sent_type === 'self' || (selfId && String(evt.user_id) === selfId)
    const id = String(evt.message_id ?? '')
    const previous = groups.get(groupId)
    const seq = /^\d+$/.test(String(evt.real_seq ?? '')) ? String(evt.real_seq) : null
    // real_seq 是群内递增序号；message_seq 在 NapCat 中是短消息 ID，不能拿来排序。
    if (id && (id === previous?.lastId || seen.get(groupId)?.has(id))) return { duplicate: true }
    if (seq && previous?.seq && BigInt(seq) <= BigInt(previous.seq)) return { duplicate: true }
    if (id) {
      const recent = seen.get(groupId) ?? new Set()
      recent.add(id)
      if (recent.size > 128) recent.delete(recent.values().next().value)
      seen.set(groupId, recent)
    }
    const hash = plusOneFingerprint(evt.message ?? evt.raw_message)
    const same = hash !== null && hash === previous?.hash
    const state = same ? previous : { hash, count: 0, fired: false }
    if (seq && previous?.seq && BigInt(seq) !== BigInt(previous.seq) + 1n) state.count = 0
    if (own || !selfId || !evt.user_id || !/^-?\d+$/.test(id) || id === '0' || !hash) state.count = 0
    else state.count = Math.min(2, state.count + 1)
    state.lastId = id
    state.seq = seq
    state.updatedAt = now()
    groups.set(groupId, state)
    if (groups.size > 1000) {
      const oldest = groups.keys().next().value
      groups.delete(oldest)
      seen.delete(oldest)
    }
    const trigger = !own && state.count === 2 && !state.fired
    if (trigger) state.fired = true
    save(trigger)
    return { groupId, state, own, suppress: !own && !!hash && (state.fired || state.count === 2), trigger, evt }
  }

  async function send(result) {
    if (!result.trigger || result.attempted || !active(result.groupId) || groups.get(result.groupId) !== result.state) return false
    result.attempted = true
    try {
      // QQ 原生单条转发：保留原文字、换行和空白，不经过回复格式处理或 LLM。
      await onebot.repeatGroupMessage(result.groupId, result.evt.message_id)
      onSent?.(result.evt)
      logger?.info?.(`[自动+1] 群 ${result.groupId} 已跟读一次（原消息 ${result.evt.message_id}；连续段不再跟读）`)
      return true
    } catch (err) {
      // 超时可能已经发送成功，不能自动重发，否则破坏一次性的约束。
      logger?.warn?.(`[自动+1] 群 ${result.groupId} 发送未确认：${err.message}；本连续段不重试`)
      return false
    }
  }

  return { observe, send, flush, wasTriggered: result => active(result.groupId) && result.state?.fired === true }
}
