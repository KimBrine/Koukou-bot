/** 只标注可确认的例行指令与固定猪猪回复，普通群友讨论仍完整保留。 */
export function summaryRoutineKind(record) {
  const text = String(record.text ?? '').trim()
  const command = text.replace(/^(?:\[@\d+\]\s*)+/, '').trim()
  if (/^\/\s*(?:今日猪猪|我的猪圈)\s*$/.test(command)) return 'pig-command'
  if (/^\/\s*(?:签到|打卡|今日运势|今日老婆|抽签)\s*$/.test(command)) return 'routine-command'
  if ((text.includes('不需要@就可以玩幽幽子的方法') && /抓到.*猪猪/.test(text)) ||
      /^【\s*@.+的猪圈】\s*📦\s*已收集\s*[:：]/u.test(text)) return 'pig-result'
  return null
}

export function summaryMeaningfulText(record) {
  return String(record.text ?? '')
    .replace(/\[(?:图片|视频|语音|表情|动画表情)[^\]]*\]|\[@\d+\]/g, '')
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
  const pigRoutineCount = counts['pig-command'] + counts['pig-result']
  const pigDiscussionChars = pigDiscussion.reduce((sum, text) => sum + [...text].length, 0)
  return { total: records.length, counts, routineCount, pigRoutineCount, ordinaryCount: ordinary.length,
    pigDiscussionCount: pigDiscussion.length, pigDiscussionChars,
    minorPigRoutine: ordinary.length >= 50 && pigRoutineCount > 0 && pigRoutineCount / records.length < 0.2 && pigDiscussion.length < 8 && pigDiscussionChars < 500,
    windows: windows.filter(w => w.messages >= 3).map(w => ({ ...w, people: w.users.size, users: undefined })),
  }
}

export function formatSummaryContentGuide(profile) {
  const { total, counts, routineCount, ordinaryCount, pigDiscussionCount } = profile
  const peakWindows = [...profile.windows].sort((a, b) => b.messages - a.messages).slice(0, 6)
  const mainWindows = peakWindows.filter(w => w.messages >= Math.max(10, ordinaryCount * 0.1))
  return [
    `完整窗口 ${total} 条；可识别的例行交互 ${routineCount} 条；有实际文字内容的普通聊天 ${ordinaryCount} 条（均按消息计数，普通聊天剔除了纯图片/表情和上述例行交互）。`,
    `猪猪例行交互 ${profile.pigRoutineCount} 条（指令 ${counts['pig-command']}、固定回复 ${counts['pig-result']}），占原始消息 ${total ? (100 * profile.pigRoutineCount / total).toFixed(1) : '0.0'}%；此外普通聊天中直接提到「猪」的 ${pigDiscussionCount} 条。这个词命中数不等于完整话题规模。`,
    ...peakWindows.map(w => `- ${stamp(w.start)}～${stamp(w.end)}：普通文字聊天 ${w.messages} 条、${w.people} 人；这是时间段统计，不是程序认定的单一话题。`),
    ordinaryCount >= 50 && mainWindows.length === 2 ? '本期普通文字明显集中在上述两个主要时段。优先组织成两项有分量的主要讨论；只有确有其他持续交流、明确主题与新信息时再增加条目。不要为了通常的3～5项数量，把几句宿舍闲聊、碎碎念或例行打卡扩写成第三个主话题。一个主要时段有多个真实独立讨论时仍可分开。' : '',
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
