import { EventEmitter } from 'node:events'
import { MessageTimeline } from './messageFreshness.js'
import { renderFacesToCq, textToSegments } from './qqFace.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 规范化消息段：容忍 {type:'text', text:'x'} 这类漏写 data 的写法，
 * 避免 NapCat 报 "Cannot read properties of undefined (reading 'text')"。
 */
function normalizeSegment(seg) {
  if (!seg || typeof seg !== 'object') return seg
  if (seg.data && typeof seg.data === 'object') return seg
  const data = {}
  if (typeof seg.text === 'string') data.text = seg.text
  if (seg.qq !== undefined) data.qq = String(seg.qq)
  if (seg.file) data.file = seg.file
  if (seg.url) data.url = seg.url
  return { type: seg.type, data }
}

/**
 * 出站消息统一处理：
 * - 字符串：把 [表情:名字] 转成 CQ 码（纯字符串消息由 NapCat 解析 CQ 码）
 * - 数组：把文本段里的表情标记拆成真正的 face 消息段（数组里的文本段不解析 CQ 码，
 *   否则用户会看到 [CQ:face,id=6] 这类字面量）
 */
function normalizeOutgoing(message) {
  if (typeof message === 'string') return renderFacesToCq(message)
  if (Array.isArray(message)) {
    const out = []
    for (const seg of message) {
      const normalized = normalizeSegment(seg)
      if (normalized && normalized.type === 'text' && typeof normalized.data?.text === 'string') {
        const pieces = textToSegments(normalized.data.text)
        if (pieces.length === 0) continue
        out.push(...pieces)
      } else if (normalized) {
        out.push(normalized)
      }
    }
    // 全是空文本时兜底给一个空文本段，避免空消息
    return out.length > 0 ? out : [{ type: 'text', data: { text: ' ' } }]
  }
  return message
}

/**
 * OneBot 11 正向 WebSocket 客户端。
 * - 与 NapCat 建立一条全双工连接：下行收事件（message 等），上行发 API 动作（send_*_msg）；
 * - 断线自动指数退避重连（1s → 30s 封顶）；
 * - 事件：'ready'（拿到登录信息）、'message'（收到消息事件）。
 */
export class OneBotClient extends EventEmitter {
  constructor({ url, logger, probeUserId = '' }) {
    super()
    this.url = url
    this.logger = logger
    this.selfId = null
    this.nickname = ''
    this.ws = null
    this.echoSeq = 0
    this.pending = new Map()
    this.stopped = false
    this.reconnectDelay = 1000
    this.qqOnline = null
    this.qqGood = null
    this.statusCheckedAt = 0
    this.statusError = ''
    this.healthTimer = null
    this.healthRequest = null
    this.probeUserId = String(probeUserId || '')
    this.probeCheckedAt = 0
    this.probeVerified = false
    this.probeError = ''
    this.accountStatusVersion = 0
    this.messageTimeline = new MessageTimeline()
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.#connectOnce()
      } catch (err) {
        if (this.stopped) return
        this.logger.warn(`OneBot 连接失败：${err.message}（${Math.round(this.reconnectDelay / 1000)}s 后重连）`)
      }
      if (this.stopped) return
      await sleep(this.reconnectDelay)
      this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2)
    }
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      let settled = false
      let ws
      try {
        ws = new WebSocket(this.url)
      } catch (err) {
        reject(err)
        return
      }
      this.ws = ws
      this.qqOnline = null
      this.qqGood = null
      this.statusCheckedAt = 0
      this.probeCheckedAt = 0
      this.probeVerified = false
      this.probeError = ''

      const cleanup = () => {
        if (this.healthTimer) clearInterval(this.healthTimer)
        this.healthTimer = null
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('message', onMessage)
        ws.removeEventListener('close', onClose)
        ws.removeEventListener('error', onError)
      }

      const onOpen = () => {
        this.messageTimeline.begin()
        this.logger.info(`已连接 OneBot：${this.url}`)
        this.reconnectDelay = 1000
        this.refreshStatus({ maxAgeMs: 0 }).catch(() => {})
        this.healthTimer = setInterval(() => this.refreshStatus({ maxAgeMs: 0 }).catch(() => {}), 5000)
        this.healthTimer.unref?.()
        this.api('get_login_info', {}, 10000)
          .then((info) => {
            this.selfId = String(info?.user_id ?? '')
            this.nickname = String(info?.nickname ?? '')
            this.logger.info(`已获取 QQ 账号信息：${this.nickname}（QQ ${this.selfId}）；在线状态单独核对`)
            this.emit('ready', { selfId: this.selfId, nickname: this.nickname })
          })
          .catch((err) => this.logger.warn(`获取登录信息失败：${err.message}`))
      }

      const onMessage = (event) => {
        let data
        try {
          data = JSON.parse(String(event.data))
        } catch {
          return
        }
        // API 调用回包：按 echo 配对
        if (data && data.echo !== undefined && this.pending.has(data.echo)) {
          const { resolve: res, reject: rej, timer } = this.pending.get(data.echo)
          this.pending.delete(data.echo)
          clearTimeout(timer)
          if (data.status === 'ok') res(data.data)
          else rej(new Error(`OneBot API 失败：retcode=${data.retcode} ${data.message || ''}`.trim()))
          return
        }
        // lifecycle 事件里也带 self_id，尽早拿到自己的 QQ 号
        if (data?.post_type === 'meta_event' && data.meta_event_type === 'heartbeat') {
          this.updateAccountStatus(data.status)
          return
        }
        if (data && data.post_type === 'meta_event' && data.meta_event_type === 'lifecycle' && data.self_id) {
          this.selfId = String(data.self_id)
          return
        }
        // 通知类事件（拍一拍 / 群成员变动 / 戳一戳等）
        if (data && data.post_type === 'notice') {
          if (data.notice_type === 'bot_offline') this.updateAccountStatus({ online: false, good: true })
          this.emit('notice', data)
          return
        }
        if (!data || !['message', 'message_sent'].includes(data.post_type)) return
        Object.defineProperty(data, 'messageContext', { value: this.messageTimeline.receive(data) })
        if (!this.probeUserId && data.user_id && String(data.user_id) !== this.selfId) this.probeUserId = String(data.user_id)
        this.emit('message', data)
      }

      const onClose = (event) => {
        this.messageTimeline.end()
        cleanup()
        if (this.ws === ws) this.ws = null
        this.qqOnline = null
        this.qqGood = null
        this.statusCheckedAt = 0
        for (const [, item] of this.pending) {
          clearTimeout(item.timer)
          item.reject(new Error('连接已断开'))
        }
        this.pending.clear()
        if (this.stopped) {
          resolve()
          return
        }
        if (!settled) {
          settled = true
          reject(new Error(`连接关闭（code=${event?.code} reason=${event?.reason || '无'}）`))
        }
      }

      const onError = (event) => {
        if (!settled) {
          settled = true
          reject(new Error(`WebSocket 错误（${event?.message || 'unknown'}）`))
        }
      }

      ws.addEventListener('open', onOpen)
      ws.addEventListener('message', onMessage)
      ws.addEventListener('close', onClose)
      ws.addEventListener('error', onError)
    })
  }

  /** 连接状态（控制台总览用） */
  status() {
    const open = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN)
    const fresh = open && this.statusCheckedAt > 0 && Date.now() - this.statusCheckedAt < 15000
    const reportedOnline = fresh ? this.qqOnline : null
    const verified = open && this.probeVerified && Date.now() - this.probeCheckedAt < 45000
    const qqOnline = reportedOnline === false ? false : reportedOnline === true && verified ? true : null
    const qqGood = fresh ? this.qqGood : null
    return { connected: open, online: qqOnline === true && qqGood !== false, qqOnline, qqGood, reportedOnline, probeVerified: verified, probeCheckedAt: this.probeCheckedAt, statusCheckedAt: this.statusCheckedAt, statusError: this.statusError || this.probeError, selfId: this.selfId, nickname: this.nickname }
  }

  updateAccountStatus(data) {
    if (typeof data?.online !== 'boolean') return false
    const previous = this.qqOnline
    if (data.online && previous === false) this.messageTimeline.begin()
    if (!data.online) this.messageTimeline.end()
    this.qqOnline = data.online
    if (!data.online) {
      this.accountStatusVersion++
      this.probeVerified = false
      this.probeCheckedAt = 0
    }
    this.qqGood = typeof data.good === 'boolean' ? data.good : null
    this.statusCheckedAt = Date.now()
    this.statusError = ''
    if (previous !== this.qqOnline) this.logger.info(`[NapCat 报告状态] ${this.qqOnline ? '在线（需实际连接核验）' : '离线'}`)
    return true
  }

  async refreshStatus({ maxAgeMs = 2000, forceProbe = false } = {}) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return this.status()
    if (!forceProbe && maxAgeMs > 0 && Date.now() - this.statusCheckedAt < maxAgeMs) return this.status()
    if (this.healthRequest?.ws === ws) {
      const pending = this.healthRequest
      return forceProbe && !pending.forceProbe ? pending.promise.then(() => this.refreshStatus({ maxAgeMs: 0, forceProbe: true })) : pending.promise
    }
    const request = { ws, promise: null, forceProbe }
    request.promise = (async () => {
      try {
        const requestedVersion = this.accountStatusVersion
        const data = await this.api('get_status', {}, 2500)
        if (this.ws !== ws || requestedVersion !== this.accountStatusVersion) return this.status()
        if (!this.updateAccountStatus(data)) throw new Error('QQ 状态接口未返回有效在线信息')
        if (data.online && data.good !== false && (forceProbe || Date.now() - this.probeCheckedAt >= 30000)) {
          const version = this.accountStatusVersion
          try {
            // get_status / 心跳只读 NapCat 内存。强制从 QQ 获取资料，核验真实请求通道。
            if (!this.probeUserId || this.probeUserId === this.selfId) throw new Error('尚未配置可核验的 QQ 账号')
            const result = await this.api('get_stranger_info', { user_id: Number(this.probeUserId), no_cache: true }, 8000)
            if (String(result?.user_id) !== this.probeUserId || !result?.nickname) throw new Error('QQ 未返回有效的实时资料')
            if (this.ws !== ws || version !== this.accountStatusVersion) return this.status()
            if (!this.probeVerified) this.logger.info('[QQ 实际连接] 核验成功')
            this.probeVerified = true
            this.probeError = ''
          } catch (err) {
            if (this.ws !== ws || version !== this.accountStatusVersion) return this.status()
            this.probeVerified = false
            this.probeError = `QQ 实际连接未确认：${err.message}`
            this.logger.warn(this.probeError)
          }
          this.probeCheckedAt = Date.now()
        }
      } catch (err) {
        if (this.ws === ws) {
          this.qqOnline = null
          this.qqGood = null
          this.statusCheckedAt = 0
          this.statusError = err.message
        }
      } finally {
        if (this.healthRequest === request) this.healthRequest = null
      }
      return this.status()
    })()
    this.healthRequest = request
    return request.promise
  }

  api(action, params = {}, timeoutMs = 8000) {    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OneBot 未连接'))
    }
    const echo = String(++this.echoSeq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot API 超时：${action}`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(err)
      }
    })
  }

  sendPrivate(userId, message) {
    return this.api('send_private_msg', { user_id: Number(userId), message: normalizeOutgoing(message) })
  }

  sendGroup(groupId, message) {
    return this.api('send_group_msg', { group_id: Number(groupId), message: normalizeOutgoing(message) })
  }

  /** QQ 原生复用一条消息（普通消息，不是合并转发卡片）；图片无需由机器人重新下载。 */
  repeatGroupMessage(groupId, messageId) {
    return this.api('forward_group_single_msg', { group_id: String(groupId), message_id: String(messageId) })
  }

  /**
   * 发送群合并转发（"聊天记录"卡片）——用于把群总结打包成一条消息发出去。
   * nodes: [{ text, name?, uin? }]，每个 node 在卡片里显示为一条独立消息。
   * 节点字段同时给 uin/name 与 user_id/nickname 两套命名，兼容不同 OneBot 实现的取值习惯。
   */
  sendGroupForward(groupId, nodes, timeoutMs = 30000) {
    const list = (Array.isArray(nodes) ? nodes : []).filter(Boolean)
    if (list.length === 0) return Promise.reject(new Error('合并转发内容为空'))
    const uin = String(this.selfId ?? '')
    const messages = list.map((n) => {
      const name = String(n.name ?? this.nickname ?? '')
      const from = String(n.uin ?? uin)
      const content = Array.isArray(n.content)
        ? n.content
        : [{ type: 'text', data: { text: String(n.content ?? n.text ?? '') } }]
      return {
        type: 'node',
        data: { uin: from, name, user_id: from, nickname: name, content },
      }
    })
    return this.api('send_group_forward_msg', { group_id: Number(groupId), messages }, timeoutMs)
  }

  /** 获取图片文件（返回 { file, url } 或报错） */
  getImage(file, timeoutMs = 15000) {
    return this.api('get_image', { file: String(file) }, timeoutMs)
  }

  /** 获取群消息历史（翻阅更早的消息时传 reverseOrder=true） */
  getGroupMsgHistory(groupId, messageSeq, timeoutMs = 15000, count = 200, reverseOrder = false) {
    const params = { group_id: Number(groupId), count: Number(count) }
    if (messageSeq != null) params.message_seq = Number(messageSeq)
    if (reverseOrder) params.reverseOrder = true
    return this.api('get_group_msg_history', params, timeoutMs)
  }

  /** 机器人已加入的群列表（换号 / 迁移验收时用来看进了哪些群） */
  getGroupList(timeoutMs = 15000) {
    return this.api('get_group_list', {}, timeoutMs)
  }

  /**
   * 退出群聊。**不可逆** —— 要回去只能被重新拉进群，所以只在"退役旧号"这种场景用。
   * dismiss 保持 false（主动退群）；true 是群主解散群，别乱传。
   */
  setGroupLeave(groupId, dismiss = false, timeoutMs = 10000) {
    return this.api('set_group_leave', { group_id: Number(groupId), is_dismiss: Boolean(dismiss) }, timeoutMs)
  }

  /** 获取群成员信息（用于拿到群名片/昵称） */
  getGroupMemberInfo(groupId, userId, timeoutMs = 8000) {
    return this.api('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId), no_cache: false }, timeoutMs)
  }

  /** 拉取整个群的成员名单（群大时慢，超时给足；/id_check 用） */
  getGroupMemberList(groupId, timeoutMs = 30000) {
    return this.api('get_group_member_list', { group_id: Number(groupId), no_cache: true }, timeoutMs)
  }

  /**
   * 把成员踢出群（需要机器人本身是管理员/群主，否则接口会报错）。
   * rejectAddRequest=true 表示同时拒绝此人再次加群——**默认 false**，
   * 只是请出去，别顺手拉黑（真需要拉黑时显式传）。
   */
  setGroupKick(groupId, userId, rejectAddRequest = false, timeoutMs = 10000) {
    return this.api(
      'set_group_kick',
      { group_id: Number(groupId), user_id: Number(userId), reject_add_request: Boolean(rejectAddRequest) },
      timeoutMs
    )
  }

  /** 按 message_id 取单条消息（用于读取被引用的消息内容；ID 用字符串传递避免精度丢失） */
  getMsg(messageId, timeoutMs = 8000) {
    return this.api('get_msg', { message_id: String(messageId) }, timeoutMs)
  }

  /** 读取合并转发卡片内容，供嵌套记录阅读与报告发送核验使用。 */
  getForwardMsg(messageId, timeoutMs = 15000) {
    return this.api('get_forward_msg', { message_id: String(messageId) }, timeoutMs)
  }

  stop() {
    this.messageTimeline.end()
    this.stopped = true
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    this.qqOnline = null
    this.qqGood = null
    this.statusCheckedAt = 0
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }
}
