/** 只标注可确认的例行指令与固定猪猪回复，普通群友讨论仍完整保留。 */
export function summaryRoutineKind(record) {
  const text = String(record.text ?? '').trim()
  const command = text.replace(/^(?:\[@\d+\]\s*)+/, '').trim()
  if (/^\/\s*(?:今日猪猪|我的猪圈)\s*$/.test(command)) return 'pig-command'
  if (/^\/\s*(?:签到|打卡|今日运势|今日老婆|抽签)\s*$/.test(command)) return 'routine-command'
  if ((/不需要@就可以玩[^\r\n]{1,40}的方法/u.test(text) && /抓到.*猪猪/.test(text)) ||
      /^【\s*@.+的猪圈】\s*📦\s*已收集\s*[:：]/u.test(text)) return 'pig-result'
  return null
}

export function summaryMeaningfulText(record) {
  return String(record.text ?? '')
    .replace(/\[(?:图片|视频|语音|表情|动画表情|合并聊天记录)[^\]]*\]|\[@\d+\]/g, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').trim()
}

const stamp = sec => {
  const d = new Date(Number(sec) * 1000)
  return Number.isNaN(d.getTime()) ? '?' : d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 16)
}

/** 用完整窗口统计选题依据；这些计数不会改动报告原始消息总数。 */
export function profileSummaryContent(records = []) {
  const counts = { 'pig-command': 0, 'pig-result': 0, 'routine-command': 0 }
  const ordinary = [], pigDiscussion = []
  for (const record of records) {
    const kind = summaryRoutineKind(record)
    if (kind) { counts[kind]++; continue }
    const text = summaryMeaningfulText(record)
    if ([...text].length < 2) continue
    ordinary.push(record)
    if (/猪/.test(text)) pigDiscussion.push(text)
  }
  const windows = []
  for (const record of ordinary) {
    const sec = Number(record.time)
    if (!Number.isFinite(sec) || sec <= 0) continue
    let window = windows.at(-1)
    if (!window || sec - window.end > 20 * 60) {
      window = { start: sec, end: sec, messages: 0, users: new Set() }; windows.push(window)
    }
    window.end = sec; window.messages++; window.users.add(String(record.userId ?? record.name ?? '?'))
  }
  const routineCount = Object.values(counts).reduce((a, b) => a + b, 0)
  const forwardCount = records.filter(r => r.forwards?.length || String(r.text ?? '').includes('[合并聊天记录]')).length
  const pigRoutineCount = counts['pig-command'] + counts['pig-result']
  const pigDiscussionChars = pigDiscussion.reduce((sum, text) => sum + [...text].length, 0)
  return { total: records.length, counts, routineCount, pigRoutineCount, ordinaryCount: ordinary.length,
    forwardCount, forwardOnly: forwardCount > 0 && ordinary.every(r => r.forwards?.length || String(r.text ?? '').includes('[合并聊天记录]')),
    pigDiscussionCount: pigDiscussion.length, pigDiscussionChars,
    minorPigRoutine: ordinary.length >= 50 && pigRoutineCount > 0 && pigRoutineCount / records.length < 0.2 && pigDiscussion.length < 8 && pigDiscussionChars < 500,
    windows: windows.filter(w => w.messages >= 3).map(w => ({ ...w, people: w.users.size, users: undefined })),
  }
}

/** 按完整窗口的有效文字样本选数量，图片占位与固定模板不放大选题预算。 */
export function summaryTopicPolicy(profile) {
  const meaningful = Math.max(0, Number(profile.ordinaryCount) || 0)
  const sparse = meaningful <= 40
  if (profile.forwardOnly) return { meaningful, sparse: true, min: 0, target: 0, max: 0 }
  return {
    meaningful, sparse,
    min: sparse ? 1 : 3,
    target: meaningful <= 10 ? 1 : sparse ? 2 : meaningful >= 800 ? 5 : meaningful >= 200 ? 4 : 3,
    max: 5,
  }
}

export function formatSummaryContentGuide(profile) {
  const { total, counts, routineCount, ordinaryCount, pigDiscussionCount } = profile
  const peakWindows = [...profile.windows].sort((a, b) => b.messages - a.messages).slice(0, 6)
  const topicPolicy = summaryTopicPolicy(profile)
  return [
    `完整窗口 ${total} 条；可识别的例行交互 ${routineCount} 条；有实际文字内容的普通聊天 ${ordinaryCount} 条（均按消息计数，普通聊天剔除了纯图片/表情和上述例行交互）。`,
    `猪猪例行交互 ${profile.pigRoutineCount} 条（指令 ${counts['pig-command']}、固定回复 ${counts['pig-result']}），占原始消息 ${total ? (100 * profile.pigRoutineCount / total).toFixed(1) : '0.0'}%；此外普通聊天中直接提到「猪」的 ${pigDiscussionCount} 条。这个词命中数不等于完整话题规模。`,
    ...peakWindows.map(w => `- ${stamp(w.start)}～${stamp(w.end)}：普通文字聊天 ${w.messages} 条、${w.people} 人；这是时间段统计，不是程序认定的单一话题。`),
    profile.forwardOnly
      ? '本期只有转发参考资料或非文本内容，没有有效群内交流；热门话题不凑数，保留标题并说明暂无足够依据。内层原话不能做本群群圣经。'
      : topicPolicy.sparse
      ? `本期有效普通文字样本只有 ${ordinaryCount} 条（不超过40条），允许按证据写1～2项话题，优先${topicPolicy.target}项；原始图片和固定模板条数不代表可总结的讨论量。`
      : `话题数量要求：完整窗口有效普通文字 ${ordinaryCount} 条，热门话题至少${topicPolicy.min}项，优先${topicPolicy.target}项，最多${topicPolicy.max}项；不能只写两项就结束。先检索整个窗口中的独立讨论、重要信息、通知、决定与安排，再按实际证据组织条目，不能为了数量编造或把同一件事机械拆分。`,
    '时间分布用于帮助通读上下文，不规定话题个数；同一时段可以有多个独立主题，同一主题也可能跨越多个时段，不能将两个活跃时段等同于两个话题。',
    profile.forwardCount ? `合并记录外层 ${profile.forwardCount} 条；只按外层消息计数。内层内容只作低权重参考，不能单列转发热门话题，也不能扩大有效文字样本或参与人数。` : '',
    profile.minorPigRoutine ? '本期猪猪主要是少量例行交互：不要排在热门话题首位；若保留独立条目，放在主要讨论之后，用一两句简述（正文最多90字），不要与主要讨论占用同样篇幅。' : '',
  ].filter(Boolean).join('\n')
}

/** 模型预算不足时优先普通文字，并覆盖窗口首尾与中间；不会只保留最早和最近消息。 */
export function selectSummaryRecords(records, budget) {
  const cap = Math.max(1, Math.floor(Number(budget) || records.length))
  if (records.length <= cap) return records
  const ordinary = [], other = []
  records.forEach((record, i) => {
    const target = !summaryRoutineKind(record) && [...summaryMeaningfulText(record)].length >= 2 ? ordinary : other
    target.push(i)
  })
  const sample = (indices, count) => count >= indices.length ? indices : count === 1 ? [indices.at(-1)] :
    Array.from({ length: count }, (_, i) => indices[Math.floor(i * (indices.length - 1) / (count - 1))])
  // 留少量名额给图片/例行交互的上下文；普通文字少时完整保留，剩余预算再补其他记录。
  const ordinaryBudget = Math.min(ordinary.length, other.length ? Math.ceil(cap * 0.9) : cap)
  const otherBudget = Math.min(other.length, cap - ordinaryBudget)
  const regularBudget = Math.min(ordinary.length, cap - otherBudget)
  return [...sample(ordinary, regularBudget), ...sample(other, otherBudget)].sort((a, b) => a - b).map(i => records[i])
}

/** 固定结果只给模型看简述，避免长模板的字数放大热度；原始记录仍用于精确统计。 */
export function renderSummaryRecordText(record) {
  if (summaryRoutineKind(record) !== 'pig-result') return String(record.text ?? '').slice(0, 120) || '（非文本消息）'
  const text = String(record.text ?? '')
  const collection = /已收集\s*[:：]\s*(\d+\s*\/\s*\d+)/.exec(text)?.[1]
  if (collection) return `[例行猪圈查询结果：已收集 ${collection}；模板已压缩，非原话]`
  const pig = /【([^【】]+)】/.exec(text)?.[1] ?? '猪猪'
  const repeat = /第\s*(\d+)\s*次/.exec(text)?.[1]
  return `[例行猪猪抽取结果：${pig}${repeat ? `，第${repeat}次` : ''}；模板已压缩，非原话]`
}
