import { parseSummaryFormat, summarySectionHeading } from './summaryFormat.js'
import { profileSummaryContent } from './summaryContent.js'

/** 用与发送相同的结构识别方式校验小节与条目，防止引文里的编号被当成话题。 */
export function inspectSummaryQuality(text, { records = [], stats = {}, contentProfile = profileSummaryContent(records) } = {}) {
  const names = { '热门话题': 'topics', '群友称号': 'members', '群圣经': 'quotes' }
  const {headings, counts, blocks} = parseSummaryFormat(text)
  // 消息少或主要是图片时不强行凑数；文字记录充足时遵守原来 3～5 项的要求。
  const substantive = contentProfile.ordinaryCount
  const min = {topics: substantive >= 50 ? 2 : 1, members: Math.min(4, Math.max(1, Number(stats.people) || 1)), quotes: substantive >= 20 ? 3 : 1}
  const issues = []
  for (const [title, key] of Object.entries(names)) if (!headings.includes(key)) issues.push(`缺少「${title}」标题`)
  if (headings.join(',') !== 'topics,members,quotes') issues.push('三个小节必须各出现一次，并按热门话题、群友称号、群圣经的顺序排列')
  if (counts.topics < min.topics) issues.push(`热门话题只有 ${counts.topics} 项，应至少 ${min.topics} 项`)
  if (counts.members < min.members) issues.push(`群友称号只有 ${counts.members} 项，应至少 ${min.members} 项`)
  if (counts.members > 5) issues.push(`群友称号有 ${counts.members} 项，最多保留 5 项`)
  if (counts.quotes < min.quotes) issues.push(`群圣经只有 ${counts.quotes} 项，应至少 ${min.quotes} 项`)
  if (contentProfile.minorPigRoutine) {
    let section = null, position = 0
    for (const block of blocks) {
      const heading = summarySectionHeading(block.split('\n', 1)[0])
      if (heading) section = heading
      if (section !== 'topics') continue
      const lines = block.split('\n'), title = lines.find(line => /^\s*\d+[.、．]/.test(line)) ?? ''
      if (!title) continue
      position++
      if (!/猪猪|猪圈|养猪|收集.*猪|猪.*收集/.test(title)) continue
      const participantLine = lines.findIndex(line => /^\s*参与者\s*[:：]/.test(line))
      const body = participantLine < 0 ? '' : lines.slice(participantLine + 1).join('\n').trim()
      if (position === 1) issues.push(`猪猪例行交互仅 ${contentProfile.pigRoutineCount}/${contentProfile.total} 条且普通讨论充足，不应排在热门话题首位`)
      if ([...body].length > 90) issues.push('少量猪猪打卡作为次要动态时，正文最多90字；把篇幅留给有实际交流的主要讨论')
    }
  }
  return {ok:issues.length === 0, counts, min, issues}
}

export async function generateCheckedSummary({ llm, prompt, messages, records, stats, contentProfile = profileSummaryContent(records), logger }) {
  let reply = await llm.chat(prompt, messages, {rejectTruncated:true})
  let quality = inspectSummaryQuality(reply, {records, stats, contentProfile})
  logger.info(`总结正文校验：${reply.length} 字，话题 ${quality.counts.topics} 项 / 群友称号 ${quality.counts.members} 项 / 群圣经 ${quality.counts.quotes} 项`)
  if (!quality.ok) {
    logger.warn(`总结正文不完整，自动修正一次：${quality.issues.join('；')}`)
    reply = await llm.chat(prompt, [
      ...messages,
      {role:'assistant',content:reply},
      {role:'user',content:`上面的报告没有满足格式要求：${quality.issues.join('；')}。请基于前面同一份真实聊天记录完整重写报告，不能只补一段。保留三个小节的标题，话题写 ${quality.min.topics}～5 项，群友称号写 ${quality.min.members}～5 项，群圣经写 ${quality.min.quotes}～5 项。每个条目及不同小节之间空一行，条目内部正常换行。覆盖不同日期及不同讨论，不要把其他话题并入一个大话题。只写记录确实支持的内容，不能为了凑数编造话题或原话；如果证据不足，请如实说明。`},
    ], {rejectTruncated:true})
    quality = inspectSummaryQuality(reply, {records, stats, contentProfile})
    logger.info(`总结修正校验：${reply.length} 字，话题 ${quality.counts.topics} 项 / 群友称号 ${quality.counts.members} 项 / 群圣经 ${quality.counts.quotes} 项`)
    if (!quality.ok) {
      const error = new Error(`总结修正后仍不完整：${quality.issues.join('；')}`)
      error.code = 'REPORT_INCOMPLETE'
      throw error
    }
  }
  return reply
}
