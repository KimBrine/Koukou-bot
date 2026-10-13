import { summaryMeaningfulText, summaryRoutineKind } from './summaryContent.js'

const generic = /合并聊天记录|聊天记录|转发消息|群聊的聊天记录|查看\d*条转发消息|\[图片\]|\[表情[^\]]*\]/g
const stop = new Set(('这个 那个 这些 那些 什么 怎么 为什么 这样 那样 一个 一下 一些 但是 因为 所以 然后 还是 就是 不是 没有 可以 觉得 现在 今天 昨天 明天 大家 我们 你们 他们 这里 那里 里面 真的 已经 知道 看到 看看 消息 记录 聊天 转发 图片 截图 分享 内容 事情 哈哈 哈哈哈 确实 好的 谢谢').split(' '))
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const referenceCue = /(?:这(?:个|段|份|张|里).{0,10}(?:记录|转发|截图|内容|说的)|(?:记录|转发|截图)(?:里|中|上|的)|刚(?:才)?(?:发|转)的)/u

function clean(text) {
  return String(text ?? '').slice(0, 2000).replace(generic, ' ')
    .replace(/https?:\/\/\S+|\[@?\d+\]|\b\d{5,}\b/g, ' ').trim()
}

function tokens(text) {
  const result = new Set()
  for (const word of segmenter.segment(clean(text))) {
    const value = word.segment.toLowerCase()
    if (word.isWordLike && value.length >= 2 && !/^\d+$/.test(value) && !stop.has(value)) result.add(value)
  }
  return result
}

/** 只读随卡片已收到的摘要及少量内嵌首层文本，不请求卡片，不递归查看嵌套内容。 */
export function summaryForwardPreview(record) {
  const bits = [summaryMeaningfulText(record)]
  const add = value => { if (typeof value === 'string') bits.push(value.slice(0, 300)) }
  for (const segment of (record.forwards ?? []).slice(0, 3)) {
    const data = segment.data ?? {}
    for (const key of ['preview', 'summary', 'title', 'desc']) add(data[key])
    const content = data.content ?? data.message
    if (typeof content === 'string') add(content.replace(/\[CQ:[^\]]*\]/g, ' '))
    else if (Array.isArray(content)) {
      for (const item of content.slice(0, 3)) {
        if (item?.type === 'text') add(item.data?.text)
        if (item?.type !== 'node') continue
        const message = item.data?.content ?? item.data?.message
        if (typeof message === 'string') add(message.replace(/\[CQ:[^\]]*\]/g, ' '))
        else if (Array.isArray(message)) for (const part of message.slice(0, 3)) if (part?.type === 'text') add(part.data?.text)
      }
    }
  }
  return clean(bits.join(' ')).slice(0, 1000)
}

/** 基于外层引用、摘要与附近真实讨论筛选；没有证据表示未知，不表示卡片已被阅读。 */
export function selectRelevantSummaryReferences(records, { contextSeconds = 10 * 60 } = {}) {
  const sources = records.filter(record => record.forwards?.length)
  if (!sources.length) return []
  const byId = new Map(records.filter(r => r.id != null).map(r => [String(r.id), r]))
  const wordCache = new Map()
  const wordsOf = record => {
    if (!wordCache.has(record)) wordCache.set(record, tokens(record.text))
    return wordCache.get(record)
  }
  const ordinary = records.filter(r => !r.forwards?.length && !summaryRoutineKind(r) &&
    clean(summaryMeaningfulText(r)).replace(/[\s\p{P}\p{S}]/gu, '').length >= 4 && wordsOf(r).size > 0)
  const candidates = []
  for (const source of sources) {
    // 显式回复可跨越时间窗口；最多追溯三跳，不能把长回复链无限扩大。
    const replies = ordinary.filter(record => {
      let target = record.replyId
      for (let hop = 0; target && hop < 3; hop++) {
        if (source.id != null && String(target) === String(source.id)) return true
        target = byId.get(String(target))?.replyId
      }
      return false
    })
    const time = Number(source.time)
    const nearby = ordinary.filter(r => time > 0 && Number(r.time) > 0 && Math.abs(Number(r.time) - time) <= contextSeconds)
    const previewTokens = tokens(summaryForwardPreview(source))
    const matched = nearby.map(record => ({ record, words: [...wordsOf(record)].filter(word => previewTokens.has(word)) }))
      .filter(item => item.words.length)
    const shared = new Set(matched.flatMap(item => item.words))
    // 多张卡片附近的模糊“记录里”只归到最近一张先前卡片，不能全部展开。
    const cues = nearby.filter(record => {
      if (!referenceCue.test(clean(record.text)) || Number(record.time) < time) return false
      const earlier = sources.filter(s => Number(s.time) > 0 && Number(s.time) <= Number(record.time))
      const nearest = earlier
        .reduce((best, s) => !best || Number(s.time) > Number(best.time) ? s : best, null)
      return nearest === source && earlier.filter(s => Number(s.time) === time).length === 1
    })
    let score = 0, reason = ''
    if (replies.length) { score = 100 + Math.min(20, replies.length); reason = '群内明确引用了这条记录' }
    else if (matched.length >= 2 && (shared.size >= 2 || [...shared].some(word => word.length >= 3))) {
      score = 50 + Math.min(20, matched.length + shared.size); reason = '外层说明或卡片摘要与附近讨论一致'
    } else if (cues.length && nearby.length >= 2) { score = 30 + Math.min(10, cues.length); reason = '附近讨论明确提到刚分享的记录' }
    if (score) candidates.push({ record: source, score, reason })
  }
  return candidates.sort((a, b) => b.score - a.score || Number(a.record.time) - Number(b.record.time))
}
