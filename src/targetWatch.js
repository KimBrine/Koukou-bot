import { limitDecorationLines, typingDelay, isQuietHour } from './humanize.js'
import { measureText, planReply, shapeReply, shapeHint, decorationHint, ensureDecoration, pickDecorationKind } from './replyShape.js'
import { replyStillCurrent, currentMessageHint } from './messageFreshness.js'
import { modelHistory } from './memory.js'
import { conversationRules } from './conversationRules.js'
import { stripInternalReplyMetadata, REPLY_REPAIR_HINT } from './replySanitizer.js'

/**
 * 盯人回复：每 N 秒检查一次目标群里指定用户是否发过言，
 * 若有，就 @ 他并用一两句话自然回应（不是逐条回复，一个窗口最多回一次）。
 * - 被 @ 的消息交给主流程回复，这里不重复处理；
 * - 主流程若刚回复过同一个人，这里也会跳过，避免出现两条回复。
 */
export function createTargetWatch({ config, logger, onebot, llm, memory, buildSystemPrompt, replyLog, rateLimiter }) {
  // 这些值改成**运行时读取**：控制台里改了盯人目标立刻生效，不用重启
  const G = () => String(config.targetWatchGroup || '')
  const U = () => String(config.targetWatchUser || '')
  const isEnabled = () => Boolean(config.targetWatchEnabled && G() && U() && onebot && llm)
  const pending = [] // { id, time, text }
  const repliedIds = new Set() // 主流程已经回复过的消息 id（精确剔除，避免误吞新消息）
  let timer = null
  let busy = false

  /** 主流程回复了某条消息时调用，避免盯人逻辑重复回复 */
  function markReplied(messageId) {
    if (messageId === undefined || messageId === null) return
    repliedIds.add(String(messageId))
    if (repliedIds.size > 200) {
      // 防止无限增长
      const first = repliedIds.values().next().value
      repliedIds.delete(first)
    }
  }

  function note(evt, parsed) {
    if (!isEnabled()) return
    if (!replyStillCurrent(onebot, evt)) return
    if (evt.message_type !== 'group') return
    if (String(evt.group_id) !== G()) return
    if (String(evt.user_id) !== U()) return
    if (parsed.atBot) return // 被 @ 的消息由主流程处理
    if (!parsed.text) return
    const id = String(evt.message_id ?? '')
    if (id && pending.some((p) => p.id === id)) return
    pending.push({
      id,
      time: Number(evt.time) || Math.floor(Date.now() / 1000),
      text: parsed.text.slice(0, 200),
      evt: { ...evt, messageContext: evt.messageContext, time: Number(evt.time) || Math.floor(Date.now() / 1000) },
    })
    logger.debug(`[盯人] 记录发言：${parsed.text.slice(0, 40)}（窗口内 ${pending.length} 条）`)
  }

  async function tick() {
    if (!isEnabled() || busy || pending.length === 0) return
    // 安静时段、限流或断线期间排队的消息不在恢复后追答。
    for (let i = pending.length - 1; i >= 0; i--) {
      if (!replyStillCurrent(onebot, pending[i].evt)) pending.splice(i, 1)
    }
    // 只剔除"主流程已经回复过"的那几条，其余（尤其是之后到达的新消息）照常处理
    if (repliedIds.size > 0) {
      const before = pending.length
      for (let i = pending.length - 1; i >= 0; i--) {
        if (repliedIds.has(pending[i].id)) pending.splice(i, 1)
      }
      repliedIds.clear()
      if (pending.length !== before) {
        logger.info(`[盯人] 跳过 ${before - pending.length} 条已被主流程回复的消息，剩余 ${pending.length} 条待回应`)
      }
    }
    if (pending.length === 0) return

    // 反检测限流 + 安静时段：盯人回复是活动量最大的路径，必须一起纳入管控
    const chatKey = `g${G()}`
    if (isQuietHour(config.quietHours)) {
      logger.debug(`[盯人] 安静时段，暂不主动回复（保留 ${pending.length} 条待下个时段）`)
      return
    }
    if (rateLimiter) {
      const gate = rateLimiter.check(chatKey)
      if (!gate.allowed) {
        logger.info(`[盯人] 限流跳过：${gate.reason}`)
        return
      }
    }

    busy = true
    const personaRevision = config.personaRevision || 0
    const samePersona = () => personaRevision === (config.personaRevision || 0)
    try {
      const memoryKey = `g${G()}`
      const batch = pending.slice()
      const latest = batch.at(-1)
      const canContinue = () => samePersona() && replyStillCurrent(onebot, latest.evt, { latestOnly: true }) && !repliedIds.has(latest.id)
      if (!canContinue()) {
        for (const item of batch) { const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1) }
        return
      }
      const count = batch.length
      const said = batch.map((p) => p.text).join(' ／ ')
      const base = buildSystemPrompt({ chatKey: memoryKey, now: new Date(), query: said })
      // 回复长度同样跟着对方走；盯人场景最多 2 行（@ 完顺手补一句就够，不宜刷屏）
      const plan = planReply({
        incomingLen: measureText(said),
        maxLines: Math.min(2, config.replyMaxLines),
        lineMaxChars: config.replyLineMaxChars,
        matchEnabled: config.replyLengthMatch,
      })
      // 装饰符号由代码按频率决定这一条准不准带、带哪种（与人设里的百分比不重复施加）
      const allowDecoration = Math.random() < config.emojiKeepRate
      const decorationPreset = config.localProfile?.decoration
      const decoKind = allowDecoration ? pickDecorationKind(Math.random, decorationPreset) : ''
      const extra = `\n\n（现在的情况：群友（QQ ${U()}）刚才说了 ${count} 句话：「${said}」。请你自然回应他，像平时群聊那样随口接话，不用面面俱到，也不要罗列。）`
      const prompt = base + extra + currentMessageHint(latest.evt) + conversationRules(config) + shapeHint(plan) + decorationHint(allowDecoration, decoKind, decorationPreset)
      const history = modelHistory(memory.get(memoryKey).slice(-20))
      let reply = stripInternalReplyMetadata(await llm.chat(prompt, history))
      if (!reply && canContinue()) reply = stripInternalReplyMetadata(await llm.chat(prompt + REPLY_REPAIR_HINT, history))
      if (!reply) {
        for (const item of batch) { const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1) }
        logger.warn('[盯人回复] 清理内部标记后无正文，取消本次发送')
        return
      }
      if (!canContinue()) {
        for (const item of batch) { const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1) }
        return
      }
      let lines = shapeReply(reply, plan)
      if (lines.length === 0) lines = ['嗯嗯']
      if (allowDecoration) lines = ensureDecoration(lines, reply, { kind: decoKind, preset: decorationPreset })
      const finalLines = limitDecorationLines(lines, allowDecoration ? 1 : 0).map(stripInternalReplyMetadata).filter(Boolean)
      const sentLines = []
      await typingDelay({ min: config.humanDelayMinMs, max: config.humanDelayMaxMs })
      for (let i = 0; i < finalLines.length; i++) {
        if (i > 0) {
          // 第 2 行是同一次说话的分条发送：跳过"最小间隔"，但仍占每小时额度
          const gate = rateLimiter?.check(chatKey, Date.now(), { ignoreGap: true })
          if (gate && !gate.allowed) {
            logger.info(`[盯人] 后续 ${finalLines.length - i} 行未发送（${gate.reason}）`)
            break
          }
          await typingDelay({ min: config.lineGapMinMs, max: config.lineGapMaxMs })
        }
        // @ 只带在第一行上，补发的行就是普通消息，像真人 @ 完接着补一句
        const segments = i === 0
          ? [{ type: 'at', data: { qq: U() } }, { type: 'text', data: { text: ` ${finalLines[i]}` } }]
          : [{ type: 'text', data: { text: finalLines[i] } }]
        if (!canContinue()) break
        await onebot.sendGroup(G(), segments)
        sentLines.push(finalLines[i])
        rateLimiter?.record(chatKey)
      }
      for (const item of batch) { const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1) }
      if (!sentLines.length || !samePersona()) return
      const record = sentLines.join('\n')
      // 写入记忆时不加任何前缀标记，否则模型会模仿这种格式带进正式回复
      memory.push(memoryKey, 'assistant', record, { replyToUserId: U(),
        replyToName: latest.evt.sender?.card || latest.evt.sender?.nickname,
        replyToMessageId: latest.evt.message_id })
      logger.info(`[盯人回复]${finalLines.length > 1 ? `（${finalLines.length} 行分条）` : ''} @${U()}：${record.replace(/\n/g, ' ⏎ ')}`)
    } catch (err) {
      logger.warn(`[盯人回复] 失败：${err.message}`)
    } finally {
      busy = false
    }
  }

  function start() {
    if (!isEnabled() || timer) return
    timer = setInterval(() => {
      tick().catch((err) => logger.warn(`[盯人回复] 异常：${err.message}`))
    }, config.targetWatchIntervalMs)
    if (timer.unref) timer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function resetPending() { pending.length = 0; repliedIds.clear() }
  /** 运行时设置盯人目标（控制台调用）：改配置 → 清空队列 → 按新目标重启定时器 */
  function configure({ enabled: en, groupId: g, userId: u } = {}) {
    if (en !== undefined) config.targetWatchEnabled = Boolean(en)
    if (g !== undefined) config.targetWatchGroup = String(g || '')
    if (u !== undefined) config.targetWatchUser = String(u || '')
    stop()
    pending.length = 0
    repliedIds.clear()
    if (isEnabled()) start()
    logger.info(
      isEnabled()
        ? `[盯人] 目标已更新：群 ${G()} 里的 ${U()}，每 ${Math.round(config.targetWatchIntervalMs / 1000)}s 检查一次`
        : '[盯人] 已关闭盯人回复',
    )
    return { enabled: isEnabled(), groupId: G(), userId: U() }
  }

  const api = {
    note, markReplied, tick, start, stop, configure, resetPending,
    pendingCount: () => pending.length,
    state: () => ({ enabled: isEnabled(), groupId: G(), userId: U() }),
  }
  // 兼容旧调用方（启动日志 / 控制台状态里用 targetWatch.enabled 这类属性）
  Object.defineProperty(api, 'enabled', { get: isEnabled })
  Object.defineProperty(api, 'groupId', { get: G })
  Object.defineProperty(api, 'userId', { get: U })
  return api
}
