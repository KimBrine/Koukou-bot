import { existsSync, readFileSync } from 'node:fs'
import { writeJsonAtomic } from './stateFile.js'
import { renderReply } from './customCommands.js'
import { parseMessage } from './cq.js'

const normalize = text => String(text || '').replace(/\r\n?/g, '\n').trim()

/** 发送结果不明确时先核对历史；读不到、分页不全或没有覆盖发送时间均不能当作“没发”。 */
export async function verifyCustomDelivery(onebot, entry) {
  if (!entry.selfId || !entry.text || !onebot.getGroupMsgHistory) return { status: 'unknown' }
  let cursor = null, oldest = Infinity, newest = 0
  const seen = new Set()
  try {
    for (let page = 0; page < 3; page++) {
      const response = await onebot.getGroupMsgHistory(entry.groupId, cursor, 8000, 100)
      const list = response?.messages ?? response?.data?.messages
      if (!Array.isArray(list) || !list.length) return { status: 'unknown' }
      let added = 0
      for (const message of list) {
        const time = Number(message.time) * 1000
        if (!Number.isFinite(time) || time <= 0) return { status: 'unknown' }
        oldest = Math.min(oldest, time); newest = Math.max(newest, time)
        const id = String(message.message_id ?? message.message_seq ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id); added++
        if (String(message.user_id ?? message.sender?.user_id) === entry.selfId && time >= entry.attemptAt-2000 &&
            normalize(parseMessage(message.message ?? message.raw_message, entry.selfId).text) === normalize(entry.text))
          return { status: 'present', messageId: id }
      }
      if (oldest <= entry.attemptAt-2000 && newest >= entry.attemptAt) return { status: 'absent' }
      if (!added) return { status: 'unknown' }
      const first = [...list].sort((a,b)=>Number(a.time)-Number(b.time))[0]
      cursor = first.message_seq ?? first.message_id
      if (cursor == null || list.length < 100) return { status: 'unknown' }
    }
  } catch {}
  return { status: 'unknown' }
}

/** 五分钟内在线核验与有限重试，回执持久化；不明确的发送不盲目重发。 */
export function createCustomCommandSchedule({ file, commands, onebot, memory, rateLimiter, logger,
  now = Date.now, retryWindowMs = 5*60000, retryDelayMs = 30000, verify = entry => verifyCustomDelivery(onebot, entry) }) {
  let records = {}, blocked = false, busy = false, timer = null, stopped = false
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (saved.version !== 1 || !saved.deliveries || typeof saved.deliveries !== 'object' || Array.isArray(saved.deliveries)) throw Error('格式不正确')
      records = saved.deliveries
    }
  } catch (err) { blocked = true; logger?.warn?.(`[自定义定时] 送达记录损坏，暂停自动发送，请恢复备份：${err.message}`) }
  function save() {
    const cutoff = now() - 14*86400000
    for (const key of Object.keys(records)) if (records[key].targetAt < cutoff) delete records[key]
    writeJsonAtomic(file, { version: 1, deliveries: records })
  }
  function status() { return structuredClone({ blocked, deliveries: records }) }
  async function online() {
    try { const health = await onebot.refreshStatus({ maxAgeMs: 0, forceProbe: true }); return health.online === true && health.connected === true }
    catch { return false }
  }
  function sent(entry, id, chatKey, memoryToken) {
    Object.assign(entry, { status: 'sent', messageId: String(id), sentAt: now() })
    save()
    rateLimiter?.record(chatKey, now())
    if (memoryToken === memory?.version?.(chatKey) && entry.memoryBoundary === memory?.cutoff?.(chatKey)) memory?.push(chatKey, 'assistant', entry.text, { time: now(), messageId: id })
  }
  async function tick() {
    if (blocked || stopped || busy) return false
    busy = true
    try {
      const eligible = commands.due(now(), { windowMs: retryWindowMs })
      if (!eligible.length || !await online()) return false
      for (const item of eligible) {
        if (stopped) break
        if (now()-item.targetAt >= retryWindowMs) continue
        const key = item.slotKey, chatKey = `g${item.groupId}`
        let entry = records[key]
        if (entry?.status === 'sent' || entry?.status === 'abandoned' || now() < (entry?.nextAttemptAt || 0)) continue
        const memoryToken = memory?.version?.(chatKey)
        if (entry?.selfId && entry.selfId !== String(onebot.selfId || '')) continue
        if (entry?.status === 'sending' || entry?.status === 'uncertain') {
          if (now()-entry.attemptAt < 10000) continue
          let proof
          try { proof = await verify(entry) } catch { proof = { status: 'unknown' } }
          if (proof.status === 'present') { sent(entry, proof.messageId, chatKey, memoryToken); continue }
          if (proof.status !== 'absent') {
            Object.assign(entry, { status: 'uncertain', nextAttemptAt: now()+retryDelayMs }); save(); continue
          }
          entry.status = 'retry'
        }
        if ((entry?.attempts || 0) >= 3) { entry.status = 'abandoned'; save(); continue }
        const gate = rateLimiter?.check(chatKey, now())
        if (gate && !gate.allowed) continue
        // 核验期间删除或停用的指令不能继续发送。
        const current = commands.all().find(c => c.id === item.command.id && c.enabled && c.scheduleEnabled)
        if (!current || !current.scheduleGroups.includes(item.groupId) || !current.scheduleTimes.includes(JSON.parse(key)[3])) continue
        if (stopped) break
        entry = records[key] = {
          ...entry, groupId: item.groupId, targetAt: item.targetAt, selfId: String(onebot.selfId || ''),
          text: entry?.text ?? renderReply(current.reply, { now: now() }), memoryBoundary: memory?.cutoff?.(chatKey),
          status: 'sending', attempts: (entry?.attempts || 0)+1, attemptAt: now(),
        }
        save() // 先记“发送中”，有回执之后才能记“已送达”。
        let receipt
        try { receipt = await onebot.sendGroup(item.groupId, [{ type: 'text', data: { text: entry.text } }]) }
        catch (err) {
          const definitelyNotDispatched = /^(OneBot 未连接|发送前已断开)$/.test(String(err.message))
          Object.assign(entry, { status: definitelyNotDispatched ? 'retry' : 'uncertain', nextAttemptAt: now()+retryDelayMs })
          save(); logger?.warn?.(`[自定义定时] 群 ${item.groupId} 未确认送达，将先核验再决定重试`); continue
        }
        const id = receipt?.message_id
        if (id == null || !String(id)) {
          Object.assign(entry, { status: 'uncertain', nextAttemptAt: now()+retryDelayMs }); save(); continue
        }
        sent(entry, id, chatKey, memoryToken)
        logger?.info?.(`[自定义定时] 群 ${item.groupId} 已确认送达`)
      }
      return true
    } catch (err) { logger?.warn?.(`[自定义定时] 本轮停止：${err.message}`); return false }
    finally { busy = false }
  }
  function start() {
    if (timer || blocked) return
    stopped = false; timer = setInterval(() => { tick().catch(()=>{}) }, 30000); timer.unref?.()
    tick().catch(()=>{})
  }
  function stop() { stopped = true; if (timer) clearInterval(timer); timer = null }
  return { tick, start, stop, status }
}
