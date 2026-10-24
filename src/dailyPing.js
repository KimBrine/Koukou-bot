/**
 * 定时指令：每天在指定时间，到指定群里 @ 某个账号并发送一条固定内容。
 *
 * 当前用途：每天 00:00 在示例群 A（200000019）@ 示例机器人（200000015）发「/今日猪猪」，
 * 触发对方的机器人。做成通用配置，以后要加别的定时指令只改 .env 即可。
 *
 * 配置（.env）：
 *   DAILY_PING_ENABLED=1
 *   DAILY_PING_TIME=00:00
 *   DAILY_PING_GROUP=200000019
 *   DAILY_PING_TARGET=200000015
 *   DAILY_PING_TEXT=/今日猪猪
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { quietBlocked } from './quietPolicy.js'

const pad2 = (n) => String(n).padStart(2, '0')
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

function parseTime(spec) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return { hh, mm }
}

/** 午夜留 10 秒缓冲，避免 QQ / 对方机器人的时钟仍在前一天。 */
export function dailyPingTarget(hh, mm, now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, hh === 0 && mm === 0 ? 10 : 0, 0)
}

export function createDailyPing({ config, logger, onebot, rateLimiter, memory, stateFile, chatSettings }) {
  const timers = new Set()
  let scheduling = false
  const time = parseTime(config.dailyPingTime)
  const enabled = Boolean(config.dailyPingEnabled && time && config.dailyPingGroup && config.dailyPingTarget)
  let lastSentAt = 0
  let scheduledSendInFlight = false

  // ── "今日已办"状态 ──────────────────────────────────────────────────
  // 为什么需要：群聊刷得快，"今天抽过猪猪"这件事几分钟就滚出记忆窗口，
  // 机器人于是又说"我还没抽"。所以单独记一份当天状态，注入系统提示词，当天一直有效。
  const dailyState = new Map() // groupId -> { date, pig, penAt }
  let nameCache = ''

  function loadState() {
    try {
      if (!stateFile || !existsSync(stateFile)) return
      const data = JSON.parse(readFileSync(stateFile, 'utf8'))
      for (const [gid, v] of Object.entries(data || {})) {
        if (v && typeof v === 'object' && v.date) dailyState.set(String(gid), v)
      }
    } catch (err) {
      logger?.warn?.(`[定时指令] 读取今日状态失败：${err.message}`)
    }
  }

  function saveState() {
    try {
      if (!stateFile) return
      mkdirSync(path.dirname(stateFile), { recursive: true })
      const obj = {}
      for (const [gid, v] of dailyState) obj[gid] = v
      writeFileSync(stateFile, JSON.stringify(obj, null, 2))
    } catch (err) {
      logger?.warn?.(`[定时指令] 保存今日状态失败：${err.message}`)
    }
  }

  /** 今天在这个群的"已办事项"，用于注入系统提示词；没有就返回空串 */
  function todayNote(chatKey) {
    const m = /^g(\d+)$/.exec(String(chatKey ?? ''))
    if (!m) return ''
    const st = dailyState.get(m[1])
    if (!st || st.date !== dateKey()) return ''
    const parts = []
    if (st.pig) {
      const count = Number(st.pigCount)
      const countNote = count === 1
        ? '对方确认这是第一次获得这只猪，不要说“又是这只猪”或“第二次抽到”'
        : count > 1
          ? `对方确认这是第${count}次获得这只猪`
          : '这只猪的累计获得次数尚未确认，不要编造具体次数'
      parts.push(`今天已确认抽到【${st.pig}】；${countNote}，也不要把发送指令的次数当成抽中次数`)
    } else if (st.at) parts.push('今天已经抽过「今日猪猪」，但猪名没有识别出来')
    else if (st.sentAt) parts.push('今天已发送「今日猪猪」，尚未确认抽取成功；不能说已经抽到，更不能编造次数')
    if (st.penAt) parts.push('也查过「我的猪圈」了')
    return parts.length ? `\n\n【今日已办（别再说没做过、也不要重复做）】${parts.join('，')}。` : ''
  }

  function markSent() {
    const gid = String(config.dailyPingGroup)
    const today = dateKey()
    const old = dailyState.get(gid)
    dailyState.set(gid, { ...(old?.date === today ? old : {}), date: today, sentAt: Date.now() })
    saveState()
  }

  /** 目标账号的昵称（写记忆时用；取不到就退回 QQ 号） */
  async function targetNickname() {
    if (nameCache) return nameCache
    try {
      const info = await onebot.getGroupMemberInfo(config.dailyPingGroup, config.dailyPingTarget)
      nameCache = info?.card || info?.nickname || ''
    } catch {
      /* 取不到就用号码 */
    }
    return nameCache
  }

  /**
   * 把机器人自己发出去的指令写进记忆。
   * 不写的话它根本不知道"我说过这句话"——主回复路径会 push，但定时指令是独立通道，
   * 表现出来就是"抽完就忘了"。
   */
  async function rememberSent(groupId, text) {
    if (!memory) return
    try {
      const nick = await targetNickname()
      const line = `@${nick || config.dailyPingTarget} ${text}`
      memory.push(`g${groupId}`, 'assistant', line)
      logger?.debug?.(`[定时指令] 已写入记忆：${line}`)
    } catch (err) {
      logger?.warn?.(`[定时指令] 写入记忆失败：${err.message}`)
    }
  }

  // 链式指令：主指令发出后，等目标账号"成功回应"，再补发第二条
  // （例：@示例机器人 /今日猪猪 → 它抓到猪猪后 → @示例机器人 /我的猪圈）
  let pendingChain = null
  let chainTimer = null
  const chainEnabled = Boolean(config.dailyPingChainEnabled && config.dailyPingChainText)
  // 匹配规则每次现取现编译（可热改，不必重启）；编译失败退回默认
  let chainMatchSource = null
  let chainMatch = null
  function currentChainMatch() {
    const src = String(config.dailyPingChainMatch || '抓到.*猪猪')
    if (src !== chainMatchSource || !chainMatch) {
      chainMatchSource = src
      try {
        chainMatch = new RegExp(src)
      } catch (err) {
        logger?.warn?.(`[定时指令] 链式匹配规则不合法（${src}），退回默认「抓到.*猪猪」`)
        chainMatch = /抓到.*猪猪/
        chainMatchSource = '抓到.*猪猪'
      }
    }
    return chainMatch
  }
  currentChainMatch()

  function clearChain(reason) {
    if (chainTimer) {
      clearTimeout(chainTimer)
      chainTimer = null
    }
    const had = Boolean(pendingChain)
    pendingChain = null
    return had ? reason : null
  }

  /**
   * 收到群消息时调用：判断目标账号是否"成功回应"了，成功就补发第二条指令。
   * 只在主指令发出后的一段窗口内有效，超时自动放弃。
   */
  async function noteMessage(evt, parsed) {
    if (!pendingChain) return
    if (String(evt.group_id) !== String(pendingChain.groupId)) return
    if (String(evt.user_id) !== String(pendingChain.target)) return
    // 同一个群中别人也会抽猪：只要回复明确指向别人，就不能记成自己的结果。
    const recipients = new Set()
    for (const seg of Array.isArray(evt.message) ? evt.message : []) {
      if (seg.type === 'at') recipients.add(String(seg.data?.qq))
      if (seg.type === 'markdown') {
        const content = String(seg.data?.content || '')
        for (const match of content.matchAll(/mqqapi:\/\/markdown\/mention\?[^)\s]*at_tinyid=(\d+)/g)) recipients.add(match[1])
      }
    }
    if (recipients.size && !recipients.has(String(onebot.selfId))) {
      logger?.debug?.('[定时指令] 回复指向其他群友，继续等待自己的抽猪结果')
      return
    }
    const text = String(parsed?.text ?? '')
    if (!currentChainMatch().test(text)) {
      logger?.debug?.(`[定时指令] ${pendingChain.target} 回应了但不匹配成功判据，继续等待：${text.slice(0, 40)}`)
      return
    }
    const chainText = pendingChain.chainText
    // 记下抽到的猪（用于"今日已办"提示，避免群聊刷屏后机器人忘记自己抽过）
    const gid = String(pendingChain.groupId)
    const pig = /【([^】]{1,20})】/.exec(text)?.[1] ?? ''
    const pigCount = /抓到一只新猪猪/.test(text) ? 1 : Number(/第\s*(\d+)\s*次抓到/.exec(text)?.[1]) || null
    const old = dailyState.get(gid)
    const st = old?.date === dateKey() ? old : {}
    dailyState.set(gid, { ...st, date: dateKey(), pig: pig || st.pig || '', pigCount, at: Date.now() })
    saveState()
    logger?.info?.(`[定时指令] 已记录今日抽猪结果：${pig || '（未解析出猪名）'}`)
    clearChain('已触发')
    // 稍微等一下再发，像人看完对方回复之后接着打字
    const delay = 2000 + Math.floor(Math.random() * 2000)
    logger?.info?.(`[定时指令] 目标账号回应成功（${text.slice(0, 30)}…），${Math.round(delay / 1000)}s 后补发「${chainText}」`)
    const t = setTimeout(() => {
      sendFollowUp(chainText).catch(() => {})
    }, delay)
    if (t.unref) t.unref()
  }

  /** 补发第二条指令（同样带 @） */
  async function sendFollowUp(text) {
    const groupId = Number(config.dailyPingGroup)
    if (quietBlocked(config, chatSettings, `g${groupId}`)) return false
    const target = String(config.dailyPingTarget)
    try {
      const res = await onebot.sendGroup(groupId, [
        { type: 'at', data: { qq: target } },
        { type: 'text', data: { text: ` ${text}` } },
      ])
      rateLimiter?.record(`g${groupId}`)
      await rememberSent(groupId, text)
      // 记下"已经查过猪圈"（当天有效）
      const old = dailyState.get(String(groupId))
      const st = old?.date === dateKey() ? old : {}
      dailyState.set(String(groupId), { ...st, date: dateKey(), penAt: Date.now() })
      saveState()
      logger?.info?.(`[定时指令] 链式补发成功：@${target} ${text}${res?.message_id ? `（message_id=${res.message_id}）` : ''}`)
      return true
    } catch (err) {
      logger?.warn?.(`[定时指令] 链式补发失败：${err.message.slice(0, 100)}`)
      return false
    }
  }

  /** 主指令发出后，登记"等目标账号回应"的状态 */
  function armChain(reason) {
    if (!chainEnabled) return
    clearChain('覆盖')
    pendingChain = {
      groupId: String(config.dailyPingGroup),
      target: String(config.dailyPingTarget),
      chainText: String(config.dailyPingChainText).trim(),
      armedAt: Date.now(),
    }
    const windowMs = Math.max(10000, Number(config.dailyPingChainWindowMs) || 90000)
    chainTimer = setTimeout(() => {
      const p = pendingChain
      pendingChain = null
      chainTimer = null
      if (p) logger?.info?.(`[定时指令] ${Math.round(windowMs / 1000)}s 内没等到目标账号的成功回应，跳过链式指令「${p.chainText}」`)
    }, windowMs)
    if (chainTimer.unref) chainTimer.unref()
    logger?.debug?.(`[定时指令] ${reason}：已登记等待目标账号回应（${Math.round(windowMs / 1000)}s 内）`)
  }

  /**
   * 核实消息是否其实已经送达。
   *
   * 为什么需要：QQ 有时会返回 `retcode=1200 ... "errMsg":"网络连接异常!"`，
   * 但消息**已经真的发出去了**（只是本地事件监听器报错）。直接重试会在群里刷出重复消息，
   * 所以失败后先翻一下最近的历史记录，确认没有再重试。
   */
  async function verifyLanded(groupId, text, target) {
    try {
      const res = await onebot.getGroupMsgHistory(groupId, null, 12000, 8)
      const list = res?.messages || []
      const since = Date.now() / 1000 - 180 // 只认最近 3 分钟
      for (const m of list) {
        if (Number(m.time) < since) continue
        if (String(m.user_id) !== String(onebot.selfId)) continue
        const raw = m.message ?? m.raw_message
        const flat = typeof raw === 'string' ? raw : JSON.stringify(raw)
        const hasAt = flat.includes(String(target))
        if (hasAt && flat.includes(text)) return true
      }
    } catch (err) {
      logger?.debug?.(`[定时指令] 送达核验失败（按未送达处理）：${err.message}`)
    }
    return false
  }

  /** 立刻发送一次；失败按 60s → 5min → 15min 重试三次（会话瞬时异常时还能救回来） */
  async function sendNow(reason = '定时触发', { attempt = 1, oncePerDay = false } = {}) {
    if (quietBlocked(config, chatSettings, `g${config.dailyPingGroup}`)) { clearChain('寂静时段'); return false }
    if (!config.dailyPingGroup || !config.dailyPingTarget) {
      logger?.warn?.('[定时指令] 未配置群号或目标账号，跳过')
      return false
    }
    const groupId = Number(config.dailyPingGroup)
    const target = String(config.dailyPingTarget)
    const text = String(config.dailyPingText ?? '').trim()
    if (oncePerDay) {
      const st = dailyState.get(String(groupId))
      if (scheduledSendInFlight || (st?.date === dateKey() && (st.sentAt || st.at || st.pig))) {
        logger?.info?.(`[定时指令] ${reason}：今天已发送或正在发送，跳过重复指令`)
        return true
      }
      scheduledSendInFlight = true
    }
    // @ 用真实 at 段，空格与正文用 text 段——这样对方收到的是真正的 @ 提醒
    const segments = [
      { type: 'at', data: { qq: target } },
      { type: 'text', data: { text: ` ${text}` } },
    ]
    const RETRY_DELAYS = [60_000, 300_000, 900_000]
    try {
      const res = await onebot.sendGroup(groupId, segments)
      lastSentAt = Date.now()
      markSent()
      rateLimiter?.record(`g${groupId}`)
      logger?.info?.(
        `[定时指令] ${reason}：已在群 ${groupId} 发送「@${target} ${text}」${attempt > 1 ? `（第 ${attempt} 次尝试成功）` : ''}${res?.message_id ? `（message_id=${res.message_id}）` : ''}`,
      )
      // 写进记忆：否则机器人不知道自己说过这句话（"抽完就忘"的根因）
      await rememberSent(groupId, text)
      // 主指令已发出 → 登记等待对方"成功回应"，成功就补发链式指令
      armChain(reason)
      return true
    } catch (err) {
      // 先确认是不是"报错但其实发出去了"
      if (await verifyLanded(groupId, text, target)) {
        lastSentAt = Date.now()
        markSent()
        rateLimiter?.record(`g${groupId}`)
        logger?.info?.(`[定时指令] ${reason}：接口报错（${err.message.slice(0, 60)}），但核验发现消息已在群里，按送达处理，不重试`)
        await rememberSent(groupId, text)
        armChain(reason)
        return true
      }
      const next = RETRY_DELAYS[attempt - 1]
      if (next === undefined) {
        logger?.error?.(
          `[定时指令] ${reason}发送失败且重试用尽：${err.message}（检查 NapCat 安装目录中的 napcat-console.log 与机器人日志是否需要重新登录）`,
        )
        return false
      }
      logger?.warn?.(`[定时指令] ${reason}发送失败（第 ${attempt} 次）：${err.message.slice(0, 80)}，核实未送达，${Math.round(next / 1000)}s 后重试`)
      const t = setTimeout(() => {
        sendNow(`${reason}（第 ${attempt + 1} 次尝试）`, { attempt: attempt + 1, oncePerDay }).catch(() => {})
      }, next)
      if (t.unref) t.unref()
      return false
    } finally {
      if (oncePerDay) scheduledSendInFlight = false
    }
  }

  function schedule() {
    if (!enabled || scheduling) return
    scheduling = true
    const { hh, mm } = time
    const gid = String(config.dailyPingGroup)
    // 补跑只尝试一次：失败也不许立刻重排（否则 delay=0 会变成死循环）
    let catchUpTried = false
    const loop = () => {
      if (!scheduling) return
      // 补跑：今天该发但还没发过（例如 00:00 时机器人正好在重启 / 根本不在线），
      // 别默默跳到明天 —— 2026-09-28 就这么漏过一次「今日猪猪」。
      // 只补**时间窗内**的（3 小时）：凌晨的仪式拖到晚上再发就很怪。
      const now = new Date()
      let target = dailyPingTarget(hh, mm, now)
      const elapsed = now.getTime() - target.getTime()
      const minsPast = Math.floor(elapsed / 60000)
      const st = dailyState.get(gid)
      const doneToday = st?.date === dateKey() && Boolean(st.sentAt || st.at || st.pig)
      const doCatchUp = !catchUpTried && !doneToday && elapsed >= 0 && elapsed <= 180 * 60000
      if (doCatchUp) {
        catchUpTried = true
        target = now
        logger?.info?.(
          `[定时指令] 今天 ${pad2(hh)}:${pad2(mm)} 已过 ${minsPast} 分钟但还没发过（当时机器人可能不在线），立刻补发一次`,
        )
      } else {
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
        logger?.info?.(
          `[定时指令] 已排期：每天 ${pad2(hh)}:${pad2(mm)}${hh === 0 && mm === 0 ? ':10（午夜缓冲）' : ''} 在群 ${config.dailyPingGroup} 发送「@${config.dailyPingTarget} ${config.dailyPingText}」（${Math.round((target.getTime() - now.getTime()) / 60000)} 分钟后首次运行）`,
        )
      }
      const waitUntilTarget = () => {
        if (!scheduling) return
        const delay = Math.max(0, Math.min(60000, target.getTime() - Date.now()))
        const timer = setTimeout(async () => {
          timers.delete(timer)
          if (!scheduling) return
          // 定时器可能略早唤醒，或电脑校时后时间倒退：到点前必须重新等待。
          if (Date.now() < target.getTime()) { waitUntilTarget(); return }
          // 同一分钟内再次排期时，避免把发送失败误判为需要立刻补跑。
          catchUpTried = true
          await sendNow(doCatchUp ? '启动补发' : '定时触发', { oncePerDay: true })
          loop()
        }, delay)
        timers.add(timer)
      }
      waitUntilTarget()
    }
    loop()
  }

  function stop() {
    scheduling = false
    for (const t of timers) clearTimeout(t)
    timers.clear()
  }

  loadState()
  if (dailyState.size > 0) logger?.info?.(`[定时指令] 已载入 ${dailyState.size} 个群的"今日已办"记录`)

  return {
    sendNow,
    sendFollowUp,
    noteMessage,
    todayNote,
    schedule,
    stop,
    enabled,
    lastSentAt: () => lastSentAt,
    pendingChain: () => (pendingChain ? { ...pendingChain } : null),
    state: () => Object.fromEntries(dailyState),
    describe: () =>
      enabled
        ? `每天 ${pad2(time.hh)}:${pad2(time.mm)}${time.hh === 0 && time.mm === 0 ? ':10（午夜缓冲）' : ''} → 群 ${config.dailyPingGroup}：@${config.dailyPingTarget} ${config.dailyPingText}` +
          (chainEnabled ? `（对方成功回应后补发「${config.dailyPingChainText}」）` : '')
        : '未启用',
  }
}
