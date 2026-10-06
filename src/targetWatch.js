import { limitDecorationLines, typingDelay, isQuietHour } from './humanize.js'
import { measureText, planReply, shapeReply, shapeHint, decorationHint, ensureDecoration, pickDecorationKind } from './replyShape.js'

/**
 * 盯人回复：每 N 秒检查一次目标群里指定用户是否发过言，
 * 若有，就 @ 他并用一两句话自然回应（不是逐条回复，一个窗口最多回一次）。
 * - 被 @ 的消息交给主流程回复，这里不重复处理；
 * - 主流程若刚回复过同一个人，这里也会跳过，避免出现两条回复。
 */
export function createTargetWatch({ config, logger, onebot, llm, memory, buildSystemPrompt, replyLog, rateLimiter }) {
  const groupId = String(config.targetWatchGroup || '')
  const userId = String(config.targetWatchUser || '')
  const enabled = Boolean(config.targetWatchEnabled && groupId && userId && onebot && llm)
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
    if (!enabled) return
    if (evt.message_type !== 'group') return
    if (String(evt.group_id) !== groupId) return
    if (String(evt.user_id) !== userId) return
    if (parsed.atBot) return // 被 @ 的消息由主流程处理
    if (!parsed.text) return
    const id = String(evt.message_id ?? '')
    if (id && pending.some((p) => p.id === id)) return
    pending.push({
      id,
      time: Number(evt.time) || Math.floor(Date.now() / 1000),
      text: parsed.text.slice(0, 200),
    })
    logger.debug(`[盯人] 记录发言：${parsed.text.slice(0, 40)}（窗口内 ${pending.length} 条）`)
  }

  async function tick() {
    if (!enabled || busy || pending.length === 0) return
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
    const chatKey = `g${groupId}`
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
    try {
      const memoryKey = `g${groupId}`
      const count = pending.length
      const said = pending.map((p) => p.text).join(' ／ ')
      const base = buildSystemPrompt({ chatKey: memoryKey, now: new Date() })
      // 回复长度同样跟着对方走；盯人场景最多 2 行（@ 完顺手补一句就够，不宜刷屏）
      const plan = planReply({
        incomingLen: measureText(said),
        maxLines: Math.min(2, config.replyMaxLines),
        lineMaxChars: config.replyLineMaxChars,
        matchEnabled: config.replyLengthMatch,
      })
      // 装饰符号由代码按频率决定这一条准不准带、带哪种（与人设里的百分比不重复施加）
      const allowDecoration = Math.random() < config.emojiKeepRate
      const decoKind = allowDecoration ? pickDecorationKind() : ''
      const extra = `\n\n（现在的情况：群友（QQ ${userId}）刚才说了 ${count} 句话：「${said}」。请你自然回应他，像平时群聊那样随口接话，不用面面俱到，也不要罗列。）`
      const reply = await llm.chat(
        base + extra + shapeHint(plan) + decorationHint(allowDecoration, decoKind),
        memory.get(memoryKey).slice(-20),
      )
      let lines = shapeReply(reply, plan)
      if (lines.length === 0) lines = ['嗯嗯']
      if (allowDecoration) lines = ensureDecoration(lines, reply, { kind: decoKind })
      const finalLines = limitDecorationLines(lines, allowDecoration ? 1 : 0)
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
          ? [{ type: 'at', data: { qq: userId } }, { type: 'text', data: { text: ` ${finalLines[i]}` } }]
          : [{ type: 'text', data: { text: finalLines[i] } }]
        await onebot.sendGroup(groupId, segments)
        rateLimiter?.record(chatKey)
      }
      const record = finalLines.join('\n')
      // 写入记忆时不加任何前缀标记，否则模型会模仿这种格式带进正式回复
      memory.push(memoryKey, 'assistant', record)
      logger.info(`[盯人回复]${finalLines.length > 1 ? `（${finalLines.length} 行分条）` : ''} @${userId}：${record.replace(/\n/g, ' ⏎ ')}`)
      pending.length = 0
    } catch (err) {
      logger.warn(`[盯人回复] 失败：${err.message}`)
    } finally {
      busy = false
    }
  }

  function start() {
    if (!enabled || timer) return
    timer = setInterval(() => {
      tick().catch((err) => logger.warn(`[盯人回复] 异常：${err.message}`))
    }, config.targetWatchIntervalMs)
    if (timer.unref) timer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { note, markReplied, tick, start, stop, pendingCount: () => pending.length, enabled, groupId, userId }
}
