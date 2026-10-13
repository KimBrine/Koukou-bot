import { parseSummaryFormat, summarySectionHeading } from './summaryFormat.js'
import { profileSummaryContent, summaryTopicPolicy } from './summaryContent.js'

/** 去除内部来源标记；过长参考整句省略，保留完整的群内讨论句子。 */
export function limitSummaryReferenceWeight(text, logger) {
  if (!String(text).includes('〔参考〕')) return text
  const parsed = parseSummaryFormat(text)
  let section = null
  const output = parsed.blocks.map(block => {
    const heading = summarySectionHeading(block.split('\n', 1)[0])
    if (heading) section = heading
    if (section !== 'topics') return block
    const lines = block.split('\n'), participant = lines.findIndex(line => /^\s*参与者\s*[:：]/.test(line))
    if (participant < 0) return block.replace(/〔\/?参考〕/g, '')
    const body = lines.slice(participant + 1).join('\n')
    const fragments = /〔参考〕([\s\S]*?)〔\/参考〕/g
    const primary = [...body.replace(fragments, '').replace(/\s/g, '')].length
    let remaining = Math.min(60, Math.floor(primary / 4))
    const limited = body.replace(fragments, (_, sentence) => {
      const length = [...sentence.replace(/\s/g, '')].length
      if (length > remaining) { logger?.warn?.('[总结参考篇幅] 参考句超出60字或话题正文20%，省略该参考句'); return '' }
      remaining -= length
      return sentence
    }).replace(/〔参考〕[^\n]*/g, '').replace(/〔\/?参考〕/g, '')
    return [...lines.slice(0, participant + 1), limited.trim()].join('\n')
  })
  return output.join('\n\n')
}

/** 用与发送相同的结构识别方式校验小节与条目，防止引文里的编号被当成话题。 */
export function inspectSummaryQuality(text, { records = [], stats = {}, contentProfile = profileSummaryContent(records) } = {}) {
  const names = { '热门话题': 'topics', '群友称号': 'members', '群圣经': 'quotes' }
  const {headings, counts, blocks} = parseSummaryFormat(text)
  // 消息少或主要是图片时不强行凑数；文字记录充足时遵守原来 3～5 项的要求。
  const substantive = contentProfile.ordinaryCount
  const topicPolicy = summaryTopicPolicy(contentProfile)
  const min = {topics: topicPolicy.min, members: Math.min(4, Math.max(1, Number(stats.people) || 1)), quotes: contentProfile.forwardOnly ? 0 : substantive >= 20 ? 3 : 1}
  const issues = []
  for (const [title, key] of Object.entries(names)) if (!headings.includes(key)) issues.push(`缺少「${title}」标题`)
  if (headings.join(',') !== 'topics,members,quotes') issues.push('三个小节必须各出现一次，并按热门话题、群友称号、群圣经的顺序排列')
  if (counts.topics < min.topics) issues.push(`热门话题只有 ${counts.topics} 项，应至少 ${min.topics} 项`)
  if (contentProfile.forwardOnly && counts.topics > 0) issues.push('没有有效群内交流，不能把转发资料单独写成热门话题')
  if (contentProfile.forwardOnly && counts.quotes > 0) issues.push('只有转发资料，内层原话不能当作本群群圣经')
  if (counts.members < min.members) issues.push(`群友称号只有 ${counts.members} 项，应至少 ${min.members} 项`)
  if (counts.members > 5) issues.push(`群友称号有 ${counts.members} 项，最多保留 5 项`)
  if (counts.quotes < min.quotes) issues.push(`群圣经只有 ${counts.quotes} 项，应至少 ${min.quotes} 项`)
  if (contentProfile.forwardCount) {
    let section = null
    for (const block of blocks) {
      const heading = summarySectionHeading(block.split('\n', 1)[0])
      if (heading) section = heading
      if (section !== 'topics') continue
      const title = block.split('\n').find(line => /^\s*\d+[.、．]/.test(line)) || ''
      if (/^\s*\d+[.、．]\s*(?:合并聊天记录|聊天记录(?:分享|解读|转发|内容)?|转发(?:分享|内容(?:解读|分享)?|记录)|瓜条(?:分享|转发|解读))\s*$/.test(title))
        issues.push('不能单列聊天记录分享或转发内容解读，转发资料只能简短辅助真实群内话题')
    }
  }
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
  return {ok:issues.length === 0, counts, min, topicPolicy, issues}
}

export async function generateCheckedSummary({ llm, prompt, messages, records, stats, contentProfile = profileSummaryContent(records), logger, signal }) {
  signal?.throwIfAborted()
  let reply = await llm.chat(prompt, messages, {rejectTruncated:true, signal})
  signal?.throwIfAborted()
  reply = limitSummaryReferenceWeight(reply, logger)
  let quality = inspectSummaryQuality(reply, {records, stats, contentProfile})
  logger.info(`总结正文校验：${reply.length} 字，话题 ${quality.counts.topics} 项 / 群友称号 ${quality.counts.members} 项 / 群圣经 ${quality.counts.quotes} 项`)
  if (!quality.ok) {
    logger.warn(`总结正文不完整，自动修正一次：${quality.issues.join('；')}`)
    reply = await llm.chat(prompt, [
      ...messages,
      {role:'assistant',content:reply},
      {role:'user',content:`上面的报告没有满足格式要求：${quality.issues.join('；')}。请基于前面同一份真实聊天记录完整重写报告，不能只补一段。保留三个小节的标题，${contentProfile.forwardOnly ? '没有有效群内交流，热门话题和群圣经不列条目，说明暂无足够依据。' : `话题写 ${quality.min.topics}～5 项，优先${quality.topicPolicy.target}项；有效普通文字样本为${quality.topicPolicy.meaningful}条。群圣经写 ${quality.min.quotes}～5 项。`}群友称号写 ${quality.min.members}～5 项。每个条目及不同小节之间空一行，条目内部正常换行。覆盖不同日期及不同讨论，也检查重要信息、通知、决定与安排，不要把其他话题并入一个大话题；两个活跃时段不等于两个话题。转发记录不单独成题，最多用60字且不超过话题正文20%补充本群真实交流，内层人物和原话不得混入本群统计、参与者与群圣经。只写记录确实支持的内容，不能为了凑数编造话题或原话，也不能用少量例行打卡凑主要话题；如果证据不足，请如实说明。`},
    ], {rejectTruncated:true, signal})
    signal?.throwIfAborted()
    reply = limitSummaryReferenceWeight(reply, logger)
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
