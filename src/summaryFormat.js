const sectionNames = { '热门话题': 'topics', '群友称号': 'members', '群圣经': 'quotes' }

export function summarySectionHeading(line) {
  const match = /^(?:#{1,6}\s*)?(?:💬|🏆)?\s*(热门话题|群友称号|群圣经)\s*[：:]?\s*$/u.exec(line.trim())
  return match ? sectionNames[match[1]] : null
}

/**
 * 按报告语义分段，而非按每个换行切断。
 * 只用真实换行识别边界；字面量 \\n 在分段完成后还原。
 * 小节标题与第一条放在一起，话题说明、称号理由及多行引文完整保留。
 */
export function parseSummaryFormat(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const headings = []
  const counts = {topics:0, members:0, quotes:0}
  if (!lines.some(line => summarySectionHeading(line))) {
    return {headings, counts, blocks:normalized.split(/\n[ \t]*\n+/).map(block => block.trim()).filter(Boolean).map(decodeNewlines)}
  }
  const blocks = []
  let section = null, current = [], title = '', hasEntry = false, quoted = false
  const flush = () => {
    const block = current.join('\n').trim()
    if (block) blocks.push(decodeNewlines(block))
    current = []
  }
  const nextText = index => {
    for (let j=index+1;j<lines.length;j++) if (lines[j].trim()) return lines[j].trim()
    return ''
  }
  for (let i=0;i<lines.length;i++) {
    const line = lines[i], trimmed = line.trim()
    const heading = !quoted ? summarySectionHeading(line) : null
    if (heading) {
      flush()
      if (title) blocks.push(title)
      title = trimmed; section = heading; headings.push(heading); hasEntry = false
      continue
    }
    const numbered = /^\d+[.、．]\s*\S/.test(trimmed)
    const topic = section === 'topics' && numbered && /^参与者\s*[:：]/.test(nextText(i))
    const member = section === 'members' && /^[•●]\s*.+?\s+[-－—–]\s*\S/.test(trimmed)
    const quote = section === 'quotes' && /^\d+[.、．]\s*["“「『]/.test(trimmed)
    const entry = !quoted && (topic || member || quote)
    if (entry) {
      if (hasEntry) flush()
      if (title) { current.push(title); title = '' }
      hasEntry = true; counts[section]++
      if (quote) {
        const opening = trimmed.search(/["“「『]/)
        quoted = !/["”」』]\s*[—－–-]{1,3}\s*\S/.test(trimmed.slice(opening + 1))
      }
    } else if (quoted && /["”」』]\s*[—－–-]{1,3}\s*\S/.test(trimmed)) {
      quoted = false
    }
    if (!trimmed && !current.length) continue
    if (title && trimmed) { current.push(title); title = '' }
    current.push(line)
  }
  flush()
  if (title) blocks.push(title)
  return {headings, counts, blocks}
}

function decodeNewlines(block) {
  return block.replace(/\\r\\n|\\n|\\r/g, '\n')
}
