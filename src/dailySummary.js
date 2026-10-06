import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseMessage } from './cq.js'
import { splitLongMessage } from './bot.js'
import { computeSummaryStats, formatUserTable, formatStatsBlock, formatReportDate } from './summaryStats.js'
import { summaryFailureMessage } from './summaryFailure.js'
import { generateCheckedSummary } from './summaryQuality.js'
import { parseSummaryFormat } from './summaryFormat.js'
import { buildSummaryNameIndex, replaceTopicQqReferences, resolveSummaryNames } from './summaryNames.js'
import { profileSummaryContent, formatSummaryContentGuide, selectSummaryRecords, renderSummaryRecordText } from './summaryContent.js'
import { createSummarySchedule, ambiguousSummarySend } from './summarySchedule.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pad2 = (n) => String(n).padStart(2, '0')

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function todayMidnightSec() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** N 天窗口的起点（days=1 表示今天 00:00；days=3 表示前天 00:00） */
function dayStartSec(daysAgo = 0) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return Math.floor(d.getTime() / 1000)
}

/** 覆盖最近 days 天的日期键列表（旧 → 新） */
function dateKeysForRange(days) {
  const keys = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    keys.push(dateKey(d))
  }
  return keys
}

function fmtTime(sec) {
  const d = new Date(sec * 1000)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtDate(sec) {
  const d = new Date(sec * 1000)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * 总结用的系统提示词：「群聊日常分析报告」格式。
 * 统计数字由代码算好后通过 stats/userTable 传入，模型只写定性内容。
 */
export function buildSummaryPrompt({ botName, dateLabel, days = 1, stats = null, userTable = '', contentGuide = '' }) {
  const scope = days === 1 ? '今天' : `最近 ${days} 天`
  return `你是「${botName}」，群里的一员。现在要给群友们出一份「群聊日常分析报告」（${scope}的群聊）。

【输出格式：严格遵守】
从「💬 热门话题」开始写，只写下面这三个小节。标题行、日期行、📊 基础统计这三部分系统会自动补上，你不要写、不要重复。
小节的标题单独占一行，紧接着就是该小节的第一条（标题与第一条之间不要空行）；同一个小节里，每一条之间必须空一行。
不同小节之间也空一行。三个小节的标题必须保留，不能省略「🏆 群友称号」。热门话题通常写 3~5 项；真实讨论高度集中时可以写 2 项，记录很少时按实际写。覆盖有分量的不同讨论，不要只挑最热的一项就结束，也不要为了凑数拆同一件事或把例行打卡包装成热点。
空行才是消息边界；一条话题内部的标题、参与者和正文可以换行，但不要插入空行，不要把同一条拆碎。
请直接输出真正的换行，不要输出字面量 \\n 或 \\r\\n。
不要用 Markdown（不要 #、不要 **、不要用 - 开头），编号用 1. 2. 3.，项目符号用 •。

💬 热门话题
1. 话题标题（10 字以内）
   参与者: 昵称A、昵称B、昵称C
   用 100~200 字把事情讲清楚：谁先说了什么、别人怎么回应、最后有没有结论。叙述里提到群友时使用群昵称，与本条「参与者」栏的昵称完全一致，保留昵称中的括号和表情；不要用 QQ 号、[QQ号] 或 [@QQ号] 指代群友。

（下一个话题之前空一行，格式同上。通常写 3~5 个，主题集中时允许 2 个；按实际讨论的重要性排序。少量例行活动如需保留，放在最后，用一两句简述，不必写满 100~200 字。）

🏆 群友称号
• 昵称 - 称号 (MBTI)
  一句话理由，必须引用下面给出的真实数据（发言条数、平均字数、表情占比、回复比例）来支撑。

（每位群友之间空一行，取发言最多的 4~5 位，最多 5 位；参与人数不足 4 位时按实际人数写，不要凑数）

💬 群圣经
1. "原话，必须是群里真实说过的，一字不改" —— 说话的昵称
   一两句点评：这句为什么有冲击力、好笑或者逆天。

（每条之间空一行，挑 3~5 条最有记忆点的，按冲击力排序）

【写作要求】
1. 用你平时的口吻写（俏皮、可爱、偶尔颜文字），但内容要扎实，不要空话套话；
2. 话题只能来自下面的真实记录，不许编造、不许脑补细节；
3. 群友称号要有辨识度，结合各人的发言风格与数据，别千篇一律；
4. 群圣经必须是真实原话（可以截取片段，但不能改动文字），优先选有冲击力、有梗的。
5. 先通读整个时间窗口，再选题：关注实际讨论量、持续时间、来回交流、信息增量、结果和后续安排。覆盖不同时段的重要内容，不能只盯开头、结尾或长消息。
6. 今日猪猪、签到、抽签、查库存等指令与自动模板回复属于例行交互；参与者多、模板长不等于讨论热。少量日常打卡只简述或省略；若真的引出持续交流、有趣变化或形成主线，可以作为主要话题，但要有真实聊天证据，不能写出记录没有的「围观、笑翻、热潮、心满意足」等反应。
7. 主要讨论可以说明不同观点、解决办法和结论；同一讨论中确有不同问题与结果时才拆开。篇幅按信息量分配，避免重要攻略或争议只写概括，却把机器人的固定回复逐项展开。
8. 参与者栏也必须使用真实群昵称，不能使用裸 QQ 号；不得把群号、QQ号或时间当作昵称。
9. 零散的「好想回家」「没事干」「哦不」等几句闲聊，不足以证明一个独立的情绪话题，更不能扩写成集体emo或互相安慰。普通话题需要连续的真实交流、新信息或明确事件；重要通知、决定和安排即使消息少，也可以保留。没有讨论结论就如实写未形成结论，禁止凭空补出「达成共识」「确认最优解」「默契安慰」「继续休息」等收尾。
10. 只写记录直接支持的事实：纯图片占位无法证明图片里是什么；外部人物的身份、游戏细节、讨论时长和群友反应，都不能凭常识猜测。时间段统计可帮助选择重点，不能把整个时段的消息或参与者直接算作某一话题的证据。

【数据说明】
- 记录格式：[时间] 昵称：内容；[表情:名字] 是 QQ 表情，[图片]/[语音]/[视频] 是非文本消息；
- 标有「模板已压缩，非原话」的例行结果是程序简述，不能引用为群圣经，不能据此脑补群友反应；
- 下面「每人数据」和统计概览都是系统精确统计的，直接引用，不要自己估算；
- 「回复比例」统计的是"用 QQ 引用回复功能"的比例，数值低只代表很少用这个功能，**绝不代表他不理别人**；
  「表情占比」是平均每条消息带几个表情，0 只代表很少发表情。不要从一个 0 推导出"高冷/不听人说话"之类的人格结论，
  要下判断就结合他的实际发言内容。

每人数据（按发言条数排序）：
${userTable}

【全窗口选题依据（系统统计）】
${contentGuide || '以完整聊天记录中的实际交流为准，避免让例行指令和长模板占据主要篇幅。'}

统计概览：${scope}共 ${stats?.total ?? '?'} 条消息、${stats?.people ?? '?'} 人参与、${stats?.chars ?? '?'} 字、${stats?.emoji ?? '?'} 个表情，最活跃时段 ${stats?.peak ?? '?'}。（报告日期：${dateLabel}）

下面是群聊记录（按时间升序，可能被截断）：`
}

/** 小节和条目独立发送；条目内换行及字面量 \n 不制造额外消息。 */
export function splitReportBlocks(text) {
  return parseSummaryFormat(text).blocks
}

/** 每张合并转发卡片限制节点数，但保留每个条目的消息边界。 */
export function chunkReportBlocks(blocks, max) {
  const size = Math.max(1, Math.floor(Number(max) || 20))
  const chunks = []
  for (let i = 0; i < blocks.length; i += size) chunks.push(blocks.slice(i, i + size))
  return chunks
}

/** 组装完整报告：标题 + 日期 + 基础统计（均由代码生成，保证数字准确）+ 模型正文 */
export function buildReportBlocks({ startKey, endKey, stats, modelText, nameIndex = buildSummaryNameIndex({ users: stats?.users }) }) {
  const head = `🎯 群聊日常分析报告\n📅 ${formatReportDate(startKey, endKey)}`
  const body = replaceTopicQqReferences(splitReportBlocks(modelText), nameIndex)
  return [head, formatStatsBlock(stats), ...body]
}

/**
 * 合并「历史回填」与「实时捕获」的记录（按 message_id 去重）。
 * 同一 id 以实时捕获的文本为准；但捕获记录若缺 replyId（早期版本捕获的没有这个字段），
 * 就从历史记录里继承——否则「回复比例」会全变成 0，模型还会据此编出"他不听别人说话"之类的理由。
 */
export function mergeRecords(history, captured, startSec) {
  const byId = new Map()
  for (const m of history) {
    if (m.time >= startSec && !byId.has(m.id)) byId.set(m.id, m)
  }
  for (const m of captured) {
    if (m.time < startSec) continue
    const prev = byId.get(m.id)
    byId.set(m.id, prev && !m.replyId && prev.replyId ? { ...m, replyId: prev.replyId } : m)
  }
  return [...byId.values()].sort((a, b) => a.time - b.time)
}

export function createDailySummary({ config, logger, onebot, llm, buildSummaryPromptFn = buildSummaryPrompt }) {
  const running = new Set()

  const summaryGroups = () =>
    config.summaryGroups.length > 0 ? config.summaryGroups : [...config.whitelistGroups]
  const summarySchedule = createSummarySchedule({ config, logger, onebot, groups: summaryGroups,
    runGroup: runSummary, isRunning,
    readEveningHistory: (groupId, startSec) => backfillHistory(groupId, 200, startSec, { includeSelf: true }),
  })

  function fileFor(groupId, key) {
    return path.join(config.dataDir, 'daily', String(groupId), `${key}.jsonl`)
  }

  /** 实时捕获：群消息按天追加写盘（重启不丢） */
  function capture(evt, parsed) {
    if (!config.summaryEnabled) return
    if (evt.message_type !== 'group') return
    if (!summaryGroups().includes(evt.group_id)) return
    if (onebot.selfId && String(evt.user_id) === onebot.selfId) return
    const record = {
      id: String(evt.message_id),
      time: Number(evt.time) || Math.floor(Date.now() / 1000),
      userId: String(evt.user_id),
      name: evt.sender?.card || evt.sender?.nickname || String(evt.user_id),
      text: parsed.text,
      // 是否在回复别人（用于统计"回复比例"）
      replyId: parsed.replyId || '',
      // 是否 @ 了机器人（用于事后重放"主动搭话有没有触发"这类问题）
      atBot: Boolean(parsed.atBot),
    }
    try {
      const file = fileFor(evt.group_id, dateKey())
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(record)}\n`)
    } catch (err) {
      logger.warn(`每日总结消息捕获失败：${err.message}`)
    }
  }

  function readCaptured(groupId, key) {
    const file = fileFor(groupId, key)
    if (!existsSync(file)) return []
    const out = []
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 跳过坏行 */
      }
    }
    return out
  }

  /** 读取最近 days 天的捕获记录（跨天文件合并） */
  function readCapturedRange(groupId, days) {
    const out = []
    for (const key of dateKeysForRange(days)) {
      out.push(...readCaptured(groupId, key))
    }
    return out
  }

  /**
   * 用 get_group_msg_history **分页**拉取，补齐捕获记录之前的历史。
   *
   * ⚠️ 必须分页，绝不能只请求一次。QQ 的历史接口一次只给一小段，**刚启动时尤其少**
   *（NapCat 的历史缓存还没热起来）。2026-09-27 的教训：用户 23:33 跑总结，机器人 23:32 才启动，
   * 单次请求只拿回 42 条，当天真实有 218 条 —— 代码却静默用了残缺数据把报告发出去了。
   * NapCat 的无游标“首屏”可能跳过离线期间的消息，即使最早时间早于零点也不能视为完整。
   * 先取首屏定位最新 seq，再从该 seq 显式向前翻；重复扫描直到本日 ID 集合稳定。
   */
  async function backfillHistory(groupId, count, startSec = 0, { includeSelf = false } = {}) {
    const byId = new Map()
    // ⚠️ 单页别要太多：NapCat 拉历史实测一次要 ~17 秒，要 900 条会直接超时，
    //    翻页循环一断就又变成"只有部分数据"。小页多翻几页更稳。
    const pageSize = Math.min(500, Math.max(200, count))
    // 超时给到 60 秒（默认 20 秒对历史接口太紧）
    const pageTimeoutMs = 60000
    const maxPages = 60
    const maxRounds = 5
    let pages = 0
    let complete = false
    let failed = false
    const add = (msgs) => {
      let newWindow = 0
      for (const m of msgs) {
        const id = String(m.message_id)
        if (byId.has(id)) continue
        byId.set(id, m)
        if (Number(m.time) >= startSec) newWindow++
      }
      return newWindow
    }
    for (let round = 1; round <= maxRounds; round++) {
      let first
      try {
        first = (await onebot.getGroupMsgHistory(groupId, null, pageTimeoutMs, pageSize, false))?.messages || []
      } catch (err) {
        logger.warn(`群 ${groupId} 历史首屏拉取失败（第 ${round} 轮）：${err.message}`)
        failed = true
        break
      }
      if (first.length === 0) {
        logger.warn(`群 ${groupId} 历史首屏为空（第 ${round} 轮）`)
        failed = true
        break
      }
      pages++
      let newWindow = add(first)
      // NapCat message_seq 是随机短 ID；同秒消息用真实群序号排序，避免把较早消息当作最新游标。
      const order = msg => Number(msg.real_seq ?? msg.message_seq)
      const latest = first.reduce((a, b) => Number(b.time) > Number(a.time) || (Number(b.time) === Number(a.time) && order(b) > order(a)) ? b : a, first[0])
      let seq = latest?.message_seq
      let covered = false
      const roundSeen = new Set()
      if (!seq) {
        logger.warn(`群 ${groupId} 首屏没有可用的 message_seq，无法校验历史完整性`)
        failed = true
        break
      }
      for (let i = 0; i < maxPages; i++) {
        let msgs
        try {
          msgs = (await onebot.getGroupMsgHistory(groupId, seq, pageTimeoutMs, pageSize, true))?.messages || []
        } catch (err) {
          logger.warn(`群 ${groupId} 历史回溯失败（第 ${round} 轮第 ${i + 1} 页）：${err.message}`)
          failed = true
          break
        }
        if (msgs.length === 0) break
        pages++
        newWindow += add(msgs)
        let fresh = 0
        for (const m of msgs) {
          const id = String(m.message_id)
          if (!roundSeen.has(id)) { roundSeen.add(id); fresh++ }
        }
        const oldestMsg = msgs.reduce((a, b) => Number(b.time) < Number(a.time) || (Number(b.time) === Number(a.time) && order(b) < order(a)) ? b : a, msgs[0])
        const oldest = Number(oldestMsg?.time) || 0
        if (startSec && oldest && oldest <= startSec) { covered = true; break }
        const nextSeq = oldestMsg?.message_seq
        if (!nextSeq || String(nextSeq) === String(seq) || fresh === 0) break
        seq = nextSeq
      }
      if (failed) break
      logger.info(`群 ${groupId} 历史同步第 ${round} 轮：新增窗口内 ${newWindow} 条，已${covered ? '' : '未'}回溯到起点`)
      if (covered && newWindow === 0 && round > 1) { complete = true; break }
      if (round < maxRounds) await sleep(700)
    }
    const out = []
    for (const m of byId.values()) {
      // 机器人自己的发言不计入统计（报告的"参与人数/发言条数"应该是群友的数据）
      if (onebot.selfId && String(m.user_id) === String(onebot.selfId)) continue
      const parsed = parseMessage(m.message ?? m.raw_message, null)
      out.push({
        id: String(m.message_id),
        time: Number(m.time) || 0,
        userId: String(m.user_id),
        name: m.sender?.card || m.sender?.nickname || String(m.user_id),
        text: parsed.text,
        replyId: parsed.replyId || '',
      })
    }
    if (out.length > 0) {
      let minT = Infinity
      let maxT = 0
      for (const r of out) {
        if (r.time && r.time < minT) minT = r.time
        if (r.time > maxT) maxT = r.time
      }
      logger.info(
        `群 ${groupId} 历史回填：${out.length} 条 / ${pages} 页，覆盖 ${fmtDate(minT)} ${fmtTime(minT)} → ${fmtDate(maxT)} ${fmtTime(maxT)}`
      )
    } else {
      logger.warn(`群 ${groupId} 历史回填一条都没拿到（${pages} 页）`)
    }
    if (!complete) logger.warn(`群 ${groupId} 历史在 ${maxRounds} 轮内未确认稳定${failed ? '（接口失败）' : ''}，禁止发送可能缺失消息的报告`)
    return { records: out, complete, ...(includeSelf ? { rawMessages: [...byId.values()] } : {}) }
  }

  /** 渲染成给模型的聊天记录；跨天时带上日期 */
  function renderLines(records, days = 1) {
    return records
      .map((r) => {
        const t = days > 1 ? `${fmtDate(r.time)} ${fmtTime(r.time)}` : fmtTime(r.time)
        return `[${t}] ${r.name}：${renderSummaryRecordText(r)}`
      })
      .join('\n')
  }

  /**
   * 每块是一条独立消息。卡片节点数超限时分成多张，不把条目重新黏在一起。
   * 合并转发不可用时仅将失败的那张卡片退回逐条发送。
   */
  async function sendReport(groupId, blocks) {
    let cards = 0
    let individual = 0
    const trackedSend = async send => {
      const receiptKey = summarySchedule.beforeSend(groupId)
      try {
        const result = await send()
        summarySchedule.acknowledged(receiptKey, result)
        return result
      } catch (err) { summarySchedule.failed(receiptKey, err); throw err }
    }
    for (const chunk of chunkReportBlocks(blocks, config.summaryMaxBlocks)) {
      if (config.summarySendMode !== 'split' && typeof onebot.sendGroupForward === 'function') {
        try {
          await trackedSend(() => onebot.sendGroupForward(
            groupId,
            chunk.map((text) => ({ text, name: config.botName, uin: onebot.selfId })),
          ))
          cards++
          continue
        } catch (err) {
          if (config.summaryFallbackEnabled && ambiguousSummarySend(err)) throw err
          logger.warn(`群 ${groupId} 合并转发失败，退回逐条发送：${err.message}`)
        }
      }
      for (const block of chunk) {
        for (const piece of splitLongMessage(block)) {
          await trackedSend(() => onebot.sendGroup(groupId, piece))
          individual++
        }
        await sleep(1000)
      }
    }
    if (cards && individual) return `合并转发 ${cards} 卡 + 逐条 ${individual} 条`
    if (cards) return `合并转发 ${cards} 卡`
    return `逐条 ${individual} 条`
  }

  /** 只数本地捕获的消息条数（不联网、不发模型），用于给用户一个诚实的等待时间预估 */
  function countCaptured(groupId, days = 1) {
    let n = 0
    for (const key of dateKeysForRange(Math.max(1, Math.min(30, days)))) {
      const file = fileFor(groupId, key)
      if (!existsSync(file)) continue
      try {
        n += readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length
      } catch {
        /* 跳过读不了的文件 */
      }
    }
    return n
  }

  /** 这个群是不是正在生成报告（用于"重复发指令"时给出反馈，而不是静默丢弃） */
  function isRunning(groupId) {
    return running.has(groupId)
  }

  /** 只算统计、不调模型（自检/排查用）：返回 { records, stats } */
  async function previewStats(groupId, days = 1) {
    const dayCount = Math.max(1, Math.min(30, Math.floor(Number(days) || 1)))
    const startSec = dayStartSec(dayCount - 1)
    const captured = readCapturedRange(groupId, dayCount)
    let history = { records: [], complete: false }
    try {
      history = await backfillHistory(groupId, Math.min(2000, dayCount * 300), startSec)
    } catch (err) {
      logger.warn(`群 ${groupId} 历史回填失败：${err.message}`)
    }
    const records = mergeRecords(history.records, captured, startSec)
    return { records, stats: computeSummaryStats(records), complete: history.complete }
  }

  async function runSummary(groupId, { dryRun = false, days = 1, scheduled = false, scheduleDay = '', scheduleTime = '' } = {}) {
    const dayCount = Math.max(1, Math.min(30, Math.floor(Number(days) || 1)))
    if (running.has(groupId)) {
      logger.info(`群 ${groupId} 的总结正在生成中，跳过本次`)
      return
    }
    running.add(groupId)
    let stage = 'model'
    try {
      const startSec = dayStartSec(dayCount - 1)
      const captured = readCapturedRange(groupId, dayCount)
      let history = { records: [], complete: false }
      try {
        history = await backfillHistory(groupId, dayCount * 300, startSec)
      } catch (err) {
        logger.warn(`群 ${groupId} 历史回填失败：${err.message}`)
      }
      if (!history.complete) {
        logger.warn(`群 ${groupId} 历史未确认完整，本次总结暂缓，避免发送偏少的统计`)
        return
      }
      let records = mergeRecords(history.records, captured, startSec)
      const total = records.length
      const scopeText = dayCount === 1 ? '今日' : `近 ${dayCount} 天`
      if (total === 0) {
        logger.info(`群 ${groupId} ${scopeText}没有可总结的消息，跳过`)
        return
      }
      // 统计必须覆盖**全天所有消息**（在截断之前算），否则"消息总数"只是喂给模型的那一部分
      const stats = computeSummaryStats(records)
      const nameIndex = buildSummaryNameIndex({ users: stats.users, records })
      const contentProfile = profileSummaryContent(records)
      const cap = Math.min(1500, config.summaryMaxMessages * dayCount)
      if (total > cap) {
        records = selectSummaryRecords(records, cap)
        logger.info(`群 ${groupId} ${scopeText}消息 ${total} 条，超出预算，截取 ${records.length} 条参与总结`)
      }
      const startKey = dateKey(new Date(startSec * 1000))
      const endKey = dateKey()
      const label = dayCount === 1 ? endKey : `${startKey} ~ ${endKey}`
      // stats 已在截断前算好（覆盖全天所有消息），模型只负责写定性内容
      logger.info(
        `群 ${groupId} ${scopeText}统计：${stats.total} 条 / ${stats.people} 人 / ${stats.chars} 字 / ${stats.emoji} 表情 / 最活跃 ${stats.peak}`,
      )
      const prompt = buildSummaryPromptFn({
        botName: config.botName,
        dateLabel: label,
        days: dayCount,
        stats,
        userTable: formatUserTable(stats, { limit: config.summaryUserRows }),
        contentGuide: formatSummaryContentGuide(contentProfile),
      })
      logger.info(`群 ${groupId} 总结选题依据：普通文字 ${contentProfile.ordinaryCount} 条；猪猪例行指令 ${contentProfile.counts['pig-command']} 条 / 固定回复 ${contentProfile.counts['pig-result']} 条；${contentProfile.minorPigRoutine ? '仅作次要动态' : '按实际讨论选题'}`)
      logger.info(`开始生成群 ${groupId} ${scopeText}报告（参与消息 ${records.length}/${total} 条）…`)
      const startedAt = Date.now()
      // 长报告要跑好几分钟，期间群里一点动静都没有会让人以为"指令没生效"。
      // 超过 3 分钟就报一声平安（只报一次，不刷屏）。
      const pingTimer = dryRun
        ? null
        : setTimeout(() => {
            onebot
              .sendGroup(groupId, '还在写呢～记录有点多，再等我一会儿下下，写完立刻发出来！')
              .catch(() => {})
          }, 180000)
      if (pingTimer?.unref) pingTimer.unref()
      let reply
      try {
        reply = await generateCheckedSummary({llm, prompt, messages:[{ role: 'user', content: renderLines(records, dayCount) }], records, stats, contentProfile, logger})
      } finally {
        if (pingTimer) clearTimeout(pingTimer)
      }
      await resolveSummaryNames({ text: reply, index: nameIndex, onebot, groupId, logger })
      const blocks = buildReportBlocks({ startKey, endKey, stats, modelText: reply, nameIndex })
      if (dryRun) {
        logger.info(`[dryRun] 群 ${groupId} ${scopeText}报告共 ${blocks.length} 块：\n\n${blocks.join('\n\n──── 分条 ────\n\n')}`)
        return
      }
      stage = 'send'
      if (scheduled) {
        // 生成期间可能掉线、跨日或已有报告；发送前再核对，离线不排队等登录。
        if (dateKey() !== scheduleDay || !(await summarySchedule.online())) {
          logger.info(`[定时总结] 群 ${groupId} ${scheduleTime} 发送前 QQ 未确认在线或已跨日，当晚放弃本次`)
          return
        }
        if (config.summaryFallbackEnabled && summarySchedule.hasDelivered(scheduleDay, groupId)) return
      }
      const how = await sendReport(groupId, blocks)
      const cost = ((Date.now() - startedAt) / 1000).toFixed(0)
      logger.info(`群 ${groupId} ${scopeText}报告已发送（${blocks.length} 块，方式：${how}，耗时 ${cost}s）`)
    } catch (err) {
      logger.error(`群 ${groupId} 总结失败：${err?.stack || err}`)
      if (!dryRun && (!scheduled || (!ambiguousSummarySend(err) && await summarySchedule.online()))) {
        // 让群里知道总结失败，别让群友干等
        try {
          await onebot.sendGroup(groupId, summaryFailureMessage(err, stage))
        } catch {
          /* 通知失败就算了 */
        }
      }
    } finally {
      running.delete(groupId)
    }
  }

  async function runAll() {
    const groups = summaryGroups()
    if (groups.length === 0) {
      logger.info('没有配置每日总结目标群，跳过')
      return
    }
    logger.info(`每日总结任务开始，目标群：${groups.join(', ')}`)
    for (const gid of groups) {
      await runSummary(gid).catch((err) => logger.error(`群 ${gid} 总结异常：${err.message}`))
      await sleep(5000)
    }
  }

  /** 手动触发（群里 @机器人 / 私聊发送「今日总结」） */
  async function trigger(groups, opts = {}) {
    for (const gid of groups) {
      runSummary(gid, opts).catch((err) => logger.error(`群 ${gid} 手动总结异常：${err.message}`))
    }
  }

  /** 定时任务：每天指定时间运行 */
  function schedule() {
    if (!config.summaryEnabled) {
      logger.info('每日总结未启用（SUMMARY_ENABLED=0）')
      return
    }
    summarySchedule.schedule()
    cleanupOld()
  }

  /** 清理 7 天前的原始消息文件 */
  function cleanupOld() {
    try {
      const root = path.join(config.dataDir, 'daily')
      if (!existsSync(root)) return
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 7)
      for (const groupDir of readdirSync(root)) {
        const dir = path.join(root, groupDir)
        try {
          for (const f of readdirSync(dir)) {
            const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
            if (m && new Date(`${m[1]}T00:00:00`).getTime() < cutoff.getTime()) {
              rmSync(path.join(dir, f))
            }
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  return { capture, runSummary, runAll, trigger, schedule, stop: summarySchedule.stop,
    summaryGroups, previewStats, countCaptured, isRunning, checkScheduled: summarySchedule.runSlot }
}
