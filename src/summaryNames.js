import { parseSummaryFormat, summarySectionHeading } from './summaryFormat.js'

/** 从完整记录收集 QQ 与昵称；保留跨日改名的别名，避免依赖模型输入的截取范围。 */
export function buildSummaryNameIndex({ users = [], records = [] } = {}) {
  const index = new Map()
  for (const person of [...users, ...records]) {
    const id = String(person.userId ?? '')
    const name = String(person.name ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!/^\d+$/.test(id) || !name || name === id) continue
    let entry = index.get(id)
    if (!entry) { entry = { name, aliases: new Set() }; index.set(id, entry) }
    entry.aliases.add(name)
  }
  return index
}

// 昵称本身也可能带「、」，先匹配完整的长昵称，避免把昵称中的一部分误认成另一人。
function listedAliases(participants, index) {
  const names = [...new Set([...index.values()].flatMap(entry => [...entry.aliases]))]
    .sort((a, b) => b.length - a.length)
  const matched = new Set(), spans = []
  for (const name of names) {
    let from = 0, at
    while ((at = participants.indexOf(name, from)) !== -1) {
      const end = at + name.length
      const left = participants.slice(0, at).trimEnd(), right = participants.slice(end).trimStart()
      if ((!left || /[、,，;；]$/.test(left)) && (!right || /^[、,，;；]/.test(right)) &&
          !spans.some(span => at < span.end && end > span.start)) {
        matched.add(name); spans.push({ start: at, end })
      }
      from = end
    }
  }
  return matched
}

const qqReference = () => /\[\s*(?:@|QQ\s*(?:号)?\s*[:：]?\s*)?(\d+)\s*\]|(?<![0-9A-Za-z_])(?:@|QQ\s*(?:号)?\s*[:：]?\s*)?(\d{5,12})(?![0-9A-Za-z_])/gi

function topicBlocks(blocks) {
  let section = null
  return blocks.map(block => {
    const heading = summarySectionHeading(block.split('\n', 1)[0])
    if (heading) section = heading
    return section === 'topics'
  })
}

function protectedSpans(text, index) {
  const spans = [...text.matchAll(/https?:\/\/[^\s<>"）)]+/g)].map(m => ({ start: m.index, end: m.index + m[0].length }))
  for (const name of new Set([...index.values()].flatMap(entry => [...entry.aliases]))) {
    let from = 0, at
    while ((at = text.indexOf(name, from)) !== -1) {
      const end = at + name.length
      // 数字昵称「811」不应保护更长 QQ 号码中恰好相同的三位数字。
      if (!(/[0-9A-Za-z_]/.test(name[0]) && /[0-9A-Za-z_]/.test(text[at - 1] ?? '')) &&
          !(/[0-9A-Za-z_]/.test(name.at(-1)) && /[0-9A-Za-z_]/.test(text[end] ?? ''))) spans.push({ start: at, end })
      from = end
    }
  }
  return spans
}

/** 语义分段之后替换热门话题中的 QQ 引用，涵盖参与者中的裸号码；保留原话与边界。 */
export function replaceTopicQqReferences(blocks, index) {
  if (!index?.size) return blocks
  const topics = topicBlocks(blocks)
  return blocks.map((block, i) => {
    if (!topics[i]) return block
    const participants = /^\s*参与者\s*[:：]([^\n]*)/m.exec(block)?.[1] ?? ''
    const listed = listedAliases(participants, index)
    const spans = protectedSpans(block, index)
    return block.replace(qqReference(), (reference, bracketId, bareId, offset) => {
      if (spans.some(span => offset < span.end && offset + reference.length > span.start)) return reference
      const id = bracketId ?? bareId
      const entry = index.get(id)
      if (!entry) return reference // 没有可靠对应关系时不猜人名。
      return [...entry.aliases].find(name => listed.has(name)) ?? entry.name
    })
  })
}

/** 有人只被提到、没发言时，用该群成员名单补查昵称；失败时保留未知身份。 */
export async function resolveSummaryNames({ text, index, onebot, groupId, logger }) {
  if (typeof onebot.getGroupMemberList !== 'function') return index
  const blocks = parseSummaryFormat(text).blocks, topics = topicBlocks(blocks), missing = new Set()
  blocks.forEach((block, i) => {
    if (!topics[i]) return
    const spans = protectedSpans(block, index)
    for (const match of block.matchAll(qqReference())) {
      const id = match[1] ?? match[2]
      if (id.length >= 5 && !index.has(id) && !spans.some(span => match.index < span.end && match.index + match[0].length > span.start)) missing.add(id)
    }
  })
  if (!missing.size) return index
  try {
    const members = await onebot.getGroupMemberList(groupId, 15000)
    const supplement = buildSummaryNameIndex({ users: (Array.isArray(members) ? members : []).filter(m => missing.has(String(m.user_id)))
      .map(m => ({ userId: m.user_id, name: m.card || m.nickname })) })
    for (const [id, entry] of supplement) index.set(id, entry)
    logger.info(`群 ${groupId} 总结昵称补查：${supplement.size}/${missing.size} 位`)
  } catch (error) { logger.warn(`群 ${groupId} 总结昵称补查失败，保留无法确认的身份：${error.message}`) }
  return index
}
