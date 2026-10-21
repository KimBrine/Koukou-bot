import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseMessage } from './cq.js'
import { splitLongMessage } from './bot.js'
import { computeSummaryStats, formatUserTable, formatStatsBlock, formatReportDate } from './summaryStats.js'
import { summaryFailureMessage, isSummaryContentRefusal, statisticsOnlySummaryBody, isSummaryTransientError } from './summaryFailure.js'
import { generateCheckedSummary } from './summaryQuality.js'
import { parseSummaryFormat } from './summaryFormat.js'
import { buildSummaryNameIndex, replaceTopicQqReferences, resolveSummaryNames } from './summaryNames.js'
import { profileSummaryContent, formatSummaryContentGuide, selectSummaryRecords, renderSummaryRecordText, summaryTopicPolicy } from './summaryContent.js'
import { createSummarySchedule, ambiguousSummarySend } from './summarySchedule.js'
import { createSummaryDeadline, createSummarySendQueue } from './summaryJobs.js'
import { prepareSummaryReferences } from './summaryReferences.js'
import { createSummaryProgress } from './summaryProgress.js'

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
不同小节之间也空一行。三个小节的标题必须保留，不能省略「🏆 群友称号」。热门话题的最低数量、优先数量和上限严格使用下方「全窗口选题依据」，高消息量时可以超过5项，不要固定写成3～5项。有效普通文字样本超过40条时至少3项，讨论量更大时最低数量也会提高；只有有效样本不超过40条时允许按实际写1~2项。覆盖有分量的不同讨论、重要信息和安排，不要只挑最热的一项就结束，也不要为了凑数拆同一件事或把例行打卡包装成热点。
空行才是消息边界；一条话题内部的标题、参与者和正文可以换行，但不要插入空行，不要把同一条拆碎。
请直接输出真正的换行，不要输出字面量 \\n 或 \\r\\n。
不要用 Markdown（不要 #、不要 **、不要用 - 开头），编号用 1. 2. 3.，项目符号用 •。

💬 热门话题
1. 话题标题（10 字以内）
   参与者: 昵称A、昵称B、昵称C
   按下方正文详细程度要求连贯归纳讨论，主要话题通常约220～400字，大样本的重要讨论可写300～500字或更多；不再以200字封顶。写清起因、具体观点和分歧、谁回应了谁、进展与结果，保留能帮助读者理解的细节，不写逐条发言流水账，也不为了凑字编造。叙述里提到群友时使用群昵称，与本条「参与者」栏的昵称完全一致，保留昵称中的括号和表情；不要用 QQ 号、[QQ号] 或 [@QQ号] 指代群友。

（下一个话题之前空一行，格式同上。数量与详细程度分别保证，不能把更多条目挤进固定总篇幅。普通讨论充足时不单列例行打卡、库存播报、单个机器人的通知或缺少回应的单人碎片；真正重要的单条通知可以简写，但不能虚构围观和多人参与。实际证据不足时允许据实简写。）

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
11. 消息发送时间用于理解顺序，不要逐句加 HH:mm、具体分钟或时段标签。正文优先用连贯的总结叙述，必要时自然衔接“随后”“后来”，也不要每句话都补一个时间词。普通话题通常不必出现发言时间；只有时间差能解释关键变化、或事情本身需要时间线时才适量保留。活动开始时间、截止时间、约定时间等有实际用途的信息必须准确保留，不得把某条消息的发送时间误当成活动发生时间。群圣经中的真实原话仍保持原样。
12. 合并聊天记录（含嵌套）的展开内容、内层人物和图片描述是低权重外部参考，不是本群当前的消息。不要将“聊天记录分享/转发内容解读”单独写成热门话题，不以材料篇幅、内层发言数或图片数量判断热度。只有本群成员确实围绕材料进行了真实交流，才在这个真实话题中用一小句补充其影响；材料描述最多占该话题正文20%，且最多60字，不重述整段材料。引用材料的完整句子用内部标记「〔参考〕句子〔/参考〕」包住，单行且不放编号；标记外必须是本群真实交流的归纳。标记会在发送前移除，过长参考句会省略。不把内层人物列入参与者、群友称号或本群发言人数，内层原话不得当作本群群圣经。没有本群交流证据时直接省略。整张卡片在统计中始终只有一条外层消息。

【数据说明】
- 记录格式：[时间] 昵称：内容；[表情:名字] 是 QQ 表情，[图片]/[语音]/[视频] 是非文本消息；
- 标有「模板已压缩，非原话」的例行结果是程序简述，不能引用为群圣经，不能据此脑补群友反应；
- 合并记录先按外层引用、卡片摘要与附近群内讨论筛选，仅展开有关联依据的材料；未展开的卡片内容未知，不要从占位符猜测其内容；
- 标有「低权重转发参考资料」的部分不参与统计、热度和话题数量，不得作为本群原话。只有转发资料而没有有效群内交流时，保留小节标题并说明没有足够依据，不为凑条目另列转发话题或虚构群圣经；
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
export function buildReportBlocks({ startKey, endKey, stats, modelText, statsOnly = false, nameIndex = buildSummaryNameIndex({ users: stats?.users }) }) {
  const head = `🎯 群聊日常分析报告${statsOnly ? '（统计版）' : ''}\n📅 ${formatReportDate(startKey, endKey)}`
  const body = replaceTopicQqReferences(splitReportBlocks(modelText), nameIndex)
  return [head, formatStatsBlock(stats), ...body]
}

/**
 * 合并「历史回填」与「实时捕获」的记录（按 message_id 去重）。
 * 同一 id 以实时捕获的文本为准；但捕获记录若缺 replyId（早期版本捕获的没有这个字段），
 * 就从历史记录里继承——否则「回复比例」会全变成 0，模型还会据此编出"他不听别人说话"之类的理由。
 */
export function mergeRecords(history, captured, startSec, endSec = Infinity) {
  const byId = new Map()
  for (const m of history) {
    if (m.time >= startSec && m.time < endSec && !byId.has(m.id)) byId.set(m.id, m)
  }
  for (const m of captured) {
    if (m.time < startSec || m.time >= endSec) continue
    const prev = byId.get(m.id)
    const forwards = m.forwards?.map(segment => {
      if (segment.data?.preview) return segment
      const old = prev?.forwards?.find(item => item.data?.id && item.data.id === segment.data?.id)
      return old?.data?.preview ? { ...segment, data: { ...segment.data, preview: old.data.preview } } : segment
    })
    byId.set(m.id, { ...m,
      ...(prev && !m.replyId && prev.replyId ? { replyId: prev.replyId } : {}),
      ...(forwards?.length ? { forwards } : {}),
      ...(prev?.forwards?.length && !m.forwards?.length ? { forwards: prev.forwards } : {}) })
  }
  return [...byId.values()].sort((a, b) => a.time - b.time)
}

export function createDailySummary({ config, logger, onebot, llm, visionLLM, imageCache, loadImage, buildSummaryPromptFn = buildSummaryPrompt }) {
  const running = new Set()
  const progress = createSummaryProgress({file:existsSync(config.dataDir)?path.join(config.dataDir,'summary-progress.json'):null,logger})
  const queueSend = createSummarySendQueue()

  const summaryGroups = () =>
    config.summaryGroups.length > 0 ? config.summaryGroups : [...config.whitelistGroups]
  const summarySchedule = createSummarySchedule({ config, logger, onebot, groups: summaryGroups,
    runGroup: runSummary, isRunning,
    readEveningHistory: (groupId, startSec, signal) => backfillHistory(groupId, 200, startSec, { includeSelf: true, signal }),
  })

  function fileFor(groupId, key) {
    return path.join(config.dataDir, 'daily', String(groupId), `${key}.jsonl`)
  }

  /** 实时捕获：群消息按天追加写盘（重启不丢） */
  function capture(evt, parsed) {
    if (!config.summaryEnabled) return
    if (evt.message_type !== 'group') return
    // 手动总结可用于白名单群；独立的定时目标不能让这些群失去实时存档。
    if (!summaryGroups().includes(Number(evt.group_id)) && !config.whitelistGroups.has(Number(evt.group_id))) return
    if (onebot.selfId && String(evt.user_id) === onebot.selfId) return
    const record = {
      id: String(evt.message_id),
      time: Number(evt.time) || Math.floor(Date.now() / 1000),
      userId: String(evt.user_id),
      name: evt.sender?.card || evt.sender?.nickname || String(evt.user_id),
      text: parsed.text,
      ...(parsed.forwards?.length ? { forwards: parsed.forwards } : {}),
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
   * 先取首屏定位最新 seq，再从该 seq 显式向前翻；重复扫描直到固定窗口的 ID 集合稳定。
   * 截止秒不含在内：同秒及之后到达的新消息继续捕获，不延长这次历史核验窗口。
   */
  async function backfillHistory(groupId, count, startSec = 0, { includeSelf = false, signal, endSec = Math.floor(Date.now() / 1000) } = {}) {
    const byId = new Map()
    // ⚠️ 单页别要太多：NapCat 拉历史实测一次要 ~17 秒，要 900 条会直接超时，
    //    翻页循环一断就又变成"只有部分数据"。小页多翻几页更稳。
    const pageSize = Math.min(500, Math.max(200, count))
    // 超时给到 60 秒（默认 20 秒对历史接口太紧）
    const pageTimeoutMs = 60000
    const maxPages = config.summaryUnrestricted ? Infinity : 60
    const maxRounds = 5
    let pages = 0
    let complete = false
    let failed = false
    let reachedStart = false
    let uncoveredStableRounds = 0
    let rounds = 0
    let cursorRecoveries = 0
    let cursorRestarts = 0
    let transientRetries=0
    async function historyRead(seq,reverse){
      try{return await onebot.getGroupMsgHistory(groupId,seq,pageTimeoutMs,pageSize,reverse)}
      catch(error){
        signal?.throwIfAborted()
        if(!isSummaryTransientError(error)||transientRetries>=3)throw error
        transientRetries++
        logger.warn(`群 ${groupId} 历史读取临时故障，当前页额外恢复一次（全程${transientRetries}/3）`)
        await sleep(700);signal?.throwIfAborted()
        return onebot.getGroupMsgHistory(groupId,seq,pageTimeoutMs,pageSize,reverse)
      }
    }
    const missingCursor = err => /消息.*不存在|message.*(?:not found|does not exist)/i.test(String(err?.message || ''))
    const order = msg => Number(msg.real_seq ?? msg.message_seq)
    const compare = (a,b) => Number(a.time)-Number(b.time) || order(a)-order(b)
    // 失效游标只改用刚读取同页内更晚的真实消息，重叠回溯，不猜测随机短ID。
    async function readPage(seq, anchorPage) {
      try { return await historyRead(seq,true) }
      catch (err) {
        signal?.throwIfAborted()
        if (!missingCursor(err)) throw err
        const anchor=anchorPage.find(m=>String(m.message_seq)===String(seq))
        const alternatives=anchor ? [...anchorPage].filter(m=>m.message_seq&&String(m.message_seq)!==String(seq)&&compare(m,anchor)>0).sort(compare) : []
        const used=new Set([String(seq)])
        let failure=err
        for (const candidate of alternatives) {
          if(cursorRecoveries>=6||used.size>=4)break
          const next=String(candidate.message_seq);if(used.has(next))continue
          used.add(next);cursorRecoveries++
          signal?.throwIfAborted()
          logger.warn(`群 ${groupId} 历史游标失效，使用同页相邻消息重叠回溯（恢复 ${cursorRecoveries}/6）`)
          try { return await historyRead(candidate.message_seq,true) }
          catch (retryError) {signal?.throwIfAborted();if(!missingCursor(retryError))throw retryError;failure=retryError}
        }
        throw failure
      }
    }
    const add = (msgs) => {
      let newWindow = 0
      for (const m of msgs) {
        const id = String(m.message_id)
        if (byId.has(id)) continue
        byId.set(id, m)
        if (Number(m.time) >= startSec && Number(m.time) < endSec) newWindow++
      }
      return newWindow
    }
    for (let round = 1; round <= maxRounds; round++) {
      rounds = round
      signal?.throwIfAborted()
      let first
      try {
        first = (await historyRead(null,false))?.messages || []
      } catch (err) {
        signal?.throwIfAborted()
        logger.warn(`群 ${groupId} 历史首屏拉取失败（第 ${round} 轮）：${err.message}`)
        failed = true
        break
      }
      signal?.throwIfAborted()
      if (first.length === 0) {
        logger.warn(`群 ${groupId} 历史首屏为空（第 ${round} 轮）`)
        failed = true
        break
      }
      pages++
      let newWindow = add(first)
      // NapCat message_seq 是随机短 ID；同秒消息用真实群序号排序，避免把较早消息当作最新游标。
      const latest = first.reduce((a, b) => Number(b.time) > Number(a.time) || (Number(b.time) === Number(a.time) && order(b) > order(a)) ? b : a, first[0])
      let seq = latest?.message_seq
      let anchorPage = first
      let cursorFailed = false
      let covered = false
      const roundSeen = new Set()
      if (!seq) {
        logger.warn(`群 ${groupId} 首屏没有可用的 message_seq，无法校验历史完整性`)
        failed = true
        break
      }
      for (let i = 0; i < maxPages; i++) {
        signal?.throwIfAborted()
        let msgs
        try {
          msgs = (await readPage(seq, anchorPage))?.messages || []
        } catch (err) {
          signal?.throwIfAborted()
          logger.warn(`群 ${groupId} 历史回溯失败（第 ${round} 轮第 ${i + 1} 页）：${err.message}`)
          failed = true
          cursorFailed = missingCursor(err)
          break
        }
        signal?.throwIfAborted()
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
        anchorPage = msgs
      }
      if(failed&&cursorFailed&&cursorRestarts<2&&round<maxRounds){
        cursorRestarts++;failed=false
        logger.warn(`群 ${groupId} 同页游标仍失效，保留已读取记录并从新首屏重扫（${cursorRestarts}/2）；本轮不视为完整`)
        await sleep(700)
        continue
      }
      if (failed) break
      reachedStart ||= covered
      logger.info(`群 ${groupId} 历史同步第 ${round} 轮：新增窗口内 ${newWindow} 条，${covered ? '已' : '未'}回溯到起点（固定截止 ${fmtDate(endSec)} ${fmtTime(endSec)}，不含截止秒）`)
      if (covered && newWindow === 0 && round > 1) { complete = true; break }
      uncoveredStableRounds = !covered && newWindow === 0 ? uncoveredStableRounds + 1 : 0
      if (uncoveredStableRounds >= 2) {
        logger.warn(`群 ${groupId} 可见历史连续两轮未增加且尚未到达起点，停止重复扫描；不将可见边界冒充完整历史`)
        break
      }
      if (round < maxRounds) await sleep(700)
    }
    const out = []
    for (const m of byId.values()) {
      if (Number(m.time) >= endSec) continue
      // 机器人自己的发言不计入统计（报告的"参与人数/发言条数"应该是群友的数据）
      if (onebot.selfId && String(m.user_id) === String(onebot.selfId)) continue
      const parsed = parseMessage(m.message ?? m.raw_message, null)
      out.push({
        id: String(m.message_id),
        time: Number(m.time) || 0,
        userId: String(m.user_id),
        name: m.sender?.card || m.sender?.nickname || String(m.user_id),
        text: parsed.text,
        ...(parsed.forwards?.length ? { forwards: parsed.forwards } : {}),
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
    const reason = complete ? '' : failed ? 'api_failed' : reachedStart ? 'history_not_stable' : 'start_not_reached'
    const firstTime = out.reduce((earliest, record) => record.time > 0 && Number.isFinite(record.time) ? Math.min(earliest, record.time) : earliest, Infinity)
    const earliestSec = Number.isFinite(firstTime) ? firstTime : 0
    if (!complete) logger.warn(`群 ${groupId} 历史经 ${rounds} 轮仍未确认完整（${reason}${earliestSec ? `，最早可见 ${fmtDate(earliestSec)} ${fmtTime(earliestSec)}` : ''}），禁止发送可能缺失消息的报告`)
    return { records: out, complete, reason, earliestSec, ...(includeSelf ? { rawMessages: [...byId.values()] } : {}) }
  }

  /** 渲染成给模型的聊天记录；跨天时带上日期 */
  function renderLines(records, days = 1) {
    return records
      .map((r) => {
        const t = days > 1 ? `${fmtDate(r.time)} ${fmtTime(r.time)}` : fmtTime(r.time)
        return `[${t}] ${r.name}：${renderSummaryRecordText(r,{unrestricted:config.summaryUnrestricted})}`
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
    return running.has(Number(groupId))
  }

  /** 只算统计、不调模型（自检/排查用）：返回 { records, stats } */
  async function previewStats(groupId, days = 1) {
    const dayCount = Math.max(1, Math.min(30, Math.floor(Number(days) || 1)))
    const endSec = Math.floor(Date.now() / 1000)
    const startSec = dayStartSec(dayCount - 1)
    const captured = readCapturedRange(groupId, dayCount)
    let history = { records: [], complete: false }
    try {
      history = await backfillHistory(groupId, Math.min(2000, dayCount * 300), startSec, { endSec })
    } catch (err) {
      logger.warn(`群 ${groupId} 历史回填失败：${err.message}`)
    }
    const records = mergeRecords(history.records, captured, startSec, endSec)
    return { records, stats: computeSummaryStats(records), complete: history.complete, reason: history.reason, earliestSec: history.earliestSec }
  }

  async function runSummary(groupId, { dryRun = false, days = 1, scheduled = false, scheduleDay = '', scheduleTime = '', statsOnly = false } = {}) {
    groupId = Number(groupId)
    const dayCount = Math.max(1, Math.min(30, Math.floor(Number(days) || 1)))
    if (running.has(groupId)) {
      logger.info(`群 ${groupId} 的总结正在生成中，跳过本次`)
      return
    }
    running.add(groupId)
    const job = progress.start(groupId,{days:dayCount,scheduled})
    const report = (stage,message,status='generating') => progress.update(groupId,job.jobId,{stage,message,status})
    const deadline = createSummaryDeadline(config)
    let stage = 'model'
    try {
      const endSec = Math.floor(Date.now() / 1000)
      const startSec = dayStartSec(dayCount - 1)
      const captured = readCapturedRange(groupId, dayCount)
      let history = { records: [], complete: false }
      try {
        history = await deadline.wait(backfillHistory(groupId, dayCount * 300, startSec, { signal: deadline.signal, endSec }))
      } catch (err) {
        deadline.signal.throwIfAborted()
        history.reason = 'api_failed'
        logger.warn(`群 ${groupId} 历史回填失败：${err.message}`)
      }
      if (!history.complete) {
        report('history','历史记录未确认完整，本次没有发布报告。','failed')
        logger.warn(`群 ${groupId} 历史未确认完整，本次总结暂缓，避免发送偏少的统计`)
        if (!dryRun && (!scheduled || await summarySchedule.online())) {
          const detail = history.reason === 'start_not_reached' && history.earliestSec
            ? `目前 QQ 接口最早只能读到 ${fmtDate(history.earliestSec)} ${fmtTime(history.earliestSec)}，还没覆盖本次要求的 ${fmtDate(startSec)} 00:00。`
            : history.reason === 'api_failed' ? 'QQ 历史读取接口出现异常，暂时无法确认记录完整。'
              : '多轮读取后仍无法确认这段时间的历史完整。'
          try { await onebot.sendGroup(groupId, `这次群总结未能生成：${detail}\n为避免把部分记录当作完整总结，本次没有发布报告；后续消息会继续存档。`) }
          catch (error) { logger.warn(`群 ${groupId} 总结历史不完整提示发送失败：${error.message}`) }
        }
        return
      }
      let records = mergeRecords(history.records, captured, startSec, endSec)
      const total = records.length
      const scopeText = dayCount === 1 ? '今日' : `近 ${dayCount} 天`
      if (total === 0) {
        report('empty','这段时间没有可总结的消息，未发送报告。','failed')
        logger.info(`群 ${groupId} ${scopeText}没有可总结的消息，跳过`)
        return
      }
      // 统计必须覆盖**全天所有消息**（在截断之前算），否则"消息总数"只是喂给模型的那一部分
      const stats = computeSummaryStats(records)
      const nameIndex = buildSummaryNameIndex({ users: stats.users, records })
      const contentProfile = profileSummaryContent(records,{botUsers:config.summaryBotUsers||[]})
      contentProfile.unrestricted=Boolean(config.summaryUnrestricted)
      const topicPolicy = summaryTopicPolicy(contentProfile)
      const referenceRecords = records
      const cap = config.summaryUnrestricted ? Infinity : Math.min(1500, config.summaryMaxMessages * dayCount)
      if (total > cap) {
        records = selectSummaryRecords(records, cap,{botUsers:config.summaryBotUsers||[]})
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
        userTable: formatUserTable(stats, { limit: config.summaryUnrestricted?stats.users.length:config.summaryUserRows }),
        contentGuide: formatSummaryContentGuide(contentProfile),
      })
      logger.info(`群 ${groupId} 总结选题依据：普通文字 ${contentProfile.ordinaryCount} 条；猪猪例行指令 ${contentProfile.counts['pig-command']} 条 / 固定回复 ${contentProfile.counts['pig-result']} 条；${contentProfile.minorPigRoutine ? '仅作次要动态' : '按实际讨论选题'}`)
      logger.info(`群 ${groupId} 话题数量策略：完整窗口 ${total} 条 / 有效普通文字 ${topicPolicy.meaningful} 条；至少 ${topicPolicy.min} 项 / 优先 ${topicPolicy.target} 项 / ${Number.isFinite(topicPolicy.max)?`最多 ${topicPolicy.max} 项`:'不设固定条数上限'}${contentProfile.forwardOnly ? '（只有参考资料，不凑话题）' : topicPolicy.sparse ? '（有效样本不足，允许1～2项）' : ''}`)
      logger.info(`开始${statsOnly ? '准备统计版' : '生成'}群 ${groupId} ${scopeText}报告（参与消息 ${records.length}/${total} 条）…`)
      const startedAt = Date.now()
      // 长报告要跑好几分钟，期间群里一点动静都没有会让人以为"指令没生效"。
      // 超过 3 分钟就报一声平安（只报一次，不刷屏）。
      const pingTimer = dryRun || statsOnly
        ? null
        : setTimeout(() => {
            onebot
              .sendGroup(groupId, '还在写呢～记录有点多，再等我一会儿下下，写完立刻发出来！')
              .catch(() => {})
          }, 180000)
      if (pingTimer?.unref) pingTimer.unref()
      let reply, degraded = statsOnly
      try {
        if (statsOnly) reply = statisticsOnlySummaryBody()
        else {
          const mainText = renderLines(records, dayCount)
          report('references',`已读取 ${total} 条消息，正在整理相关聊天记录及图片`)
          const references = await deadline.wait(prepareSummaryReferences({ records: referenceRecords, onebot, visionLLM, imageCache, loadImage,
            logger, signal: deadline.signal, mainChars: mainText.length, maxImages: config.summaryReferenceMaxImages ?? 6,unrestricted:config.summaryUnrestricted }))
          const input = mainText + (references.text ? `\n\n${references.text}` : '')
          report('model',`已读取 ${total} 条消息，正在生成和检查总结正文`)
          reply = await deadline.wait(generateCheckedSummary({llm, prompt, messages:[{ role: 'user', content: input }], records, stats, contentProfile, logger, signal: deadline.signal}))
        }
      } catch (error) {
        if (!isSummaryContentRefusal(error)) throw error
        deadline.signal.throwIfAborted()
        degraded = true
        reply = statisticsOnlySummaryBody({ contentRefused: true })
        logger.warn(`群 ${groupId} 总结模型内容检查未通过，改发明确标注的统计版；不重复提交原始内容`)
      } finally {
        if (pingTimer) clearTimeout(pingTimer)
      }
      report('format','正在核对昵称和排版')
      if (!degraded) await deadline.wait(resolveSummaryNames({ text: reply, index: nameIndex, onebot, groupId, logger }))
      deadline.signal.throwIfAborted()
      deadline.close()
      const blocks = buildReportBlocks({ startKey, endKey, stats, modelText: reply, statsOnly: degraded, nameIndex })
      if (dryRun) {
        report('preview','预览生成完成，未向群聊发送。','success')
        logger.info(`[dryRun] 群 ${groupId} ${scopeText}报告共 ${blocks.length} 块：\n\n${blocks.join('\n\n──── 分条 ────\n\n')}`)
        return
      }
      stage = 'send'
      report('queued','正文已生成，等待发送到本群')
      const how = await queueSend(async () => {
        if (scheduled) {
          // 生成或发送排队期间可能掉线、跨日或已有报告；实际发送前核对。
          if (dateKey() !== scheduleDay || !(await summarySchedule.online())) {
            logger.info(`[定时总结] 群 ${groupId} ${scheduleTime} 发送前 QQ 未确认在线或已跨日，当晚放弃本次`)
            return
          }
          if (config.summaryFallbackEnabled && summarySchedule.hasDelivered(scheduleDay, groupId)) return
        }
        report('sending','正在发送到本群')
        return sendReport(groupId, blocks)
      })
      if (!how) { report('skipped','发送前条件发生变化或已有报告，本次未发送。','failed'); return }
      report('done',degraded?'统计版报告已发送；未生成热门话题正文。':'完整群总结已生成并发送到本群。','success')
      const cost = ((Date.now() - startedAt) / 1000).toFixed(0)
      logger.info(`群 ${groupId} ${scopeText}报告已发送（${degraded ? '统计版，' : ''}${blocks.length} 块，方式：${how}，耗时 ${cost}s）`)
    } catch (err) {
      report(stage,`本次${stage==='send'?'发送':'生成'}失败：${String(err?.message||err).slice(0,300)}${ambiguousSummarySend(err)?'；发送结果不明，请先核对群内消息，勿直接重复生成。':''}`,'failed')
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
      deadline.close()
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

  return { capture, runSummary, runAll, trigger, progress, schedule, stop: summarySchedule.stop,
    summaryGroups, previewStats, countCaptured, isRunning, checkScheduled: summarySchedule.runSlot }
}
