/**
 * 百度千帆 AI Search（联网搜索）客户端。
 * 接口：POST https://qianfan.baidubce.com/v2/ai_search/web_search
 * 鉴权：Authorization: Bearer bce-v3/ALTAK-...
 * 返回 { summary, refs }：summary 是百度的总结文本，refs 是结构化结果列表。
 */
export function createWebSearch({ apiKey, baseUrl = 'https://qianfan.baidubce.com/v2/ai_search', timeoutMs = 20000, logger }) {
  if (!apiKey) return null

  return async function webSearch(query) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}/web_search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: String(query).slice(0, 400) }],
          search_strategy: 'speed',
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        throw new Error(`百度搜索 HTTP ${res.status}：${detail}`)
      }
      const data = await res.json()
      const refs = (data.references || []).slice(0, 6).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        date: r.date || '',
        snippet: String(r.content || r.snippet || '').slice(0, 300),
      }))
      let summary = typeof data.content === 'string' && data.content.trim() ? data.content.trim() : ''
      if (!summary) {
        summary = refs
          .map((r, i) => `[${i + 1}] ${r.title}${r.date ? `（${r.date}）` : ''}\n${r.snippet}\n${r.url}`)
          .join('\n\n')
      }
      return { summary, refs }
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('百度搜索超时')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}
