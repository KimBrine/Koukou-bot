// OneBot 的 time 为发送时刻（秒），不是登录后补发的接收时刻。
export const LIVE_MESSAGE_MAX_AGE_MS = 90_000

export function messageTime(evt) {
  const value = Number(evt?.time)
  return Number.isFinite(value) && value > 0 && value * 1000 <= 8.64e15 ? value * 1000 : null
}

export class MessageTimeline {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.session = 0
    this.startedAt = 0
    this.available = false
    this.latest = new Map()
    this.revision = 0
  }

  begin() {
    this.session++
    this.startedAt = Math.floor(this.now() / 1000) * 1000
    this.available = true
    this.latest.clear()
  }

  end() {
    if (this.available) this.session++
    this.available = false
    this.latest.clear()
  }

  receive(evt) {
    const receivedAt = this.now()
    const time = messageTime(evt)
    const key = evt.message_type === 'private' ? `p${evt.user_id}` : `g${evt.group_id}`
    const historical = !this.available || time === null || time < this.startedAt ||
      receivedAt - time > LIVE_MESSAGE_MAX_AGE_MS || time - receivedAt > 30_000
    const revision = ++this.revision
    if (!historical && evt.post_type !== 'message_sent' && evt.message_sent_type !== 'self' &&
        String(evt.user_id) !== String(evt.self_id)) {
      if (time >= (this.latest.get(key)?.time || 0)) this.latest.set(key, { revision, time })
      if (this.latest.size > 1000) this.latest.delete(this.latest.keys().next().value)
    }
    return { session: this.session, time, receivedAt, key, revision, historical }
  }

  isCurrent(ticket, { latestOnly = false } = {}) {
    return !!ticket && !ticket.historical && this.available && ticket.session === this.session &&
      this.now() - ticket.time <= LIVE_MESSAGE_MAX_AGE_MS &&
      (!latestOnly || this.latest.get(ticket.key)?.revision === ticket.revision)
  }
}

export function replyStillCurrent(onebot, evt, options) {
  if (onebot.messageTimeline) return onebot.messageTimeline.isCurrent(evt.messageContext, options)
  // 小型集成或测试客户端没有会话信息时，也不能回应明显过期的消息。
  const time = messageTime(evt)
  return time === null || (Date.now() - time <= LIVE_MESSAGE_MAX_AGE_MS && time - Date.now() <= 30_000)
}

export function currentMessageHint(evt) {
  const time = messageTime(evt)
  const userId = /^\d{1,24}$/.test(String(evt?.user_id)) ? `当前发言者的用户标识为 ${evt.user_id}。` : ''
  return `\n\n【聊天时效】当前要回应的是最后一条新消息${time ? `（发送时间 ${new Date(time).toISOString()}）` : ''}。${userId}带历史时间或登录补读标记的消息、长期记忆用于理解背景，不是等待补答的请求。优先衔接当前话题：可以使用最近几轮的原话理解当前短句、动作和省略，不要求对方重新复述或明确询问旧事。不要逐条补答旧问题，不要把登录补读的旧事说成“刚才”发生；较早背景只有与当前消息有关时才使用。不要在回复中输出内部时间标记。`
}
