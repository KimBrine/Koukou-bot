/**
 * 联网搜索统一出口（优先走 API，不依赖网页抓取）。
 * - 通义千问联网搜索：DashScope 原生接口 + enable_search（用现有 DASHSCOPE_API_KEY）
 * - 百度千帆 AI Search：配置 BAIDU_QIANFAN_API_KEY 时可用
 * - 必应网页：没有上面两个 Key 时的兜底（解析 b_algo）
 * provider：auto（千帆 > DeepSeek > 通义 > 必应）/ deepseek / dashscope / baidu / bing / off
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 50
const DASHSCOPE_NATIVE = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation'

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCodePoint(parseInt(hex, 16)) })
    .replace(/&#(\d+);/g, function (_, dec) { return String.fromCodePoint(Number(dec)) })
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripTags(value) {
  return decodeEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 必应结果链接是 /ck/a?u=a1<base64url>，还原成真实地址 */
export function decodeBingUrl(href) {
  try {
    const url = new URL(String(href || ''), 'https://cn.bing.com')
    if (!/\/ck\/a/.test(url.pathname)) return url.href
    const raw = url.searchParams.get('u') || ''
    if (!raw.startsWith('a1')) return url.href
    const base64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(base64, 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : url.href
  } catch {
    return String(href || '')
  }
}

export function parseBingResults(html) {
  const out = []
  const seen = new Set()
  const blocks = String(html || '').split(/<li class="b_algo"/i).slice(1)
  for (const block of blocks) {
    const head = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!head) continue
    const title = stripTags(head[2])
    const url = decodeBingUrl(decodeEntities(head[1]))
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue
    const para = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    seen.add(url)
    out.push({ title: title, url: url, date: '', snippet: (para ? stripTags(para[1]) : '').slice(0, 300) })
    if (out.length >= 6) break
  }
  return out
}

function refsSummary(refs) {
  return (refs || []).map(function (r, i) {
    return '[' + (i + 1) + '] ' + r.title + (r.date ? '（' + r.date + '）' : '') + '\n' + r.snippet + '\n' + r.url
  }).join('\n\n')
}

export function createWebSearch(options) {
  const opts = options || {}
  const apiKey = opts.apiKey
  const dashscopeApiKey = opts.dashscopeApiKey
  const deepseekApiKey = opts.deepseekApiKey
  const dashscopeModel = opts.dashscopeModel || 'qwen-plus'
  const baseUrl = opts.baseUrl || 'https://qianfan.baidubce.com/v2/ai_search'
  const timeoutMs = opts.timeoutMs || 20000
  const fetchImpl = opts.fetchImpl || fetch
  const bingHost = opts.bingHost || 'https://cn.bing.com'
  const mode = String(opts.provider || 'auto').trim().toLowerCase()
  if (mode === 'off') return null
  const cache = new Map()

  async function searchDashscope(query) {
    const controller = new AbortController()
    const timer = setTimeout(function () { controller.abort() }, timeoutMs)
    try {
      const res = await fetchImpl(DASHSCOPE_NATIVE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dashscopeApiKey },
        body: JSON.stringify({
          model: dashscopeModel,
          input: { messages: [{ role: 'user', content: String(query).slice(0, 400) }] },
          parameters: {
            enable_search: true,
            search_options: { forced_search: true, search_strategy: 'turbo', enable_source: true, enable_citation: true },
            result_format: 'message',
            max_tokens: 800,
          },
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = String(await res.text().catch(function () { return '' })).slice(0, 200)
        throw new Error('通义搜索 HTTP ' + res.status + '：' + detail)
      }
      const data = await res.json()
      const choices = data && data.output && data.output.choices
      const text = String((choices && choices[0] && choices[0].message && choices[0].message.content) || '').trim()
      if (!text) throw new Error('通义搜索没有返回内容')
      const refs=(data.output?.search_info?.search_results||[]).slice(0,6).filter(r=>/^https?:\/\//i.test(r.url||'')).map(r=>({title:r.title||'',url:r.url,date:r.date||'',snippet:r.snippet||''}))
      return { summary: text+(refs.length?'\n\n搜索来源：\n'+refsSummary(refs):''), refs, provider: 'dashscope' }
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('通义搜索超时')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async function searchDeepseek(query) {
    const controller = new AbortController()
    const timer = setTimeout(function () { controller.abort() }, timeoutMs)
    try {
      const res = await fetchImpl('https://api.deepseek.com/v1/tools/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + deepseekApiKey },
        body: JSON.stringify({ query: String(query).slice(0, 128), count: 5, ori_question: String(query).slice(0, 128) }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = String(await res.text().catch(function () { return '' })).slice(0, 200)
        throw new Error('DeepSeek 搜索 HTTP ' + res.status + '：' + detail)
      }
      const data = await res.json()
      const refs = (data.results || []).slice(0, 5).map(function (r) {
        return {
          title: r.title || '',
          url: r.url || '',
          date: r.date || '',
          snippet: String(r.summary || r.snippet || '').slice(0, 500),
        }
      })
      if (!refs.length) throw new Error('DeepSeek 没有搜到结果')
      return { summary: refsSummary(refs), refs: refs, provider: 'deepseek' }
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('DeepSeek 搜索超时')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async function searchBaidu(query) {
    const controller = new AbortController()
    const timer = setTimeout(function () { controller.abort() }, timeoutMs)
    try {
      const res = await fetchImpl(baseUrl + '/web_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          messages: [{ role: 'user', content: String(query).slice(0, 400) }],
          search_strategy: 'speed',
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = String(await res.text().catch(function () { return '' })).slice(0, 200)
        throw new Error('百度搜索 HTTP ' + res.status + '：' + detail)
      }
      const data = await res.json()
      const refs = (data.references || []).slice(0, 6).map(function (r) {
        return {
          title: r.title || '',
          url: r.url || '',
          date: r.date || '',
          snippet: String(r.content || r.snippet || '').slice(0, 300),
        }
      })
      let summary = typeof data.content === 'string' && data.content.trim() ? data.content.trim() : ''
      if (!summary) summary = refsSummary(refs)
      return { summary: summary, refs: refs, provider: 'baidu' }
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('百度搜索超时')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async function searchBing(query) {
    const hosts = [bingHost, 'https://www.bing.com'].filter(function (h, i, all) { return all.indexOf(h) === i })
    let lastError = null
    for (const host of hosts) {
      const controller = new AbortController()
      const timer = setTimeout(function () { controller.abort() }, timeoutMs)
      try {
        const url = host + '/search?q=' + encodeURIComponent(String(query).slice(0, 400)) + '&setlang=zh-CN&ensearch=0'
        const res = await fetchImpl(url, {
          headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', accept: 'text/html' },
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('必应搜索 HTTP ' + res.status)
        const refs = parseBingResults(await res.text())
        if (!refs.length) throw new Error('必应没有解析到结果')
        return { summary: refsSummary(refs), refs: refs, provider: 'bing' }
      } catch (err) {
        lastError = err && err.name === 'AbortError' ? new Error('必应搜索超时') : err
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError || new Error('必应搜索失败')
  }

  const hasBaidu = Boolean(apiKey)
  const hasDashscope = Boolean(dashscopeApiKey)
  const hasDeepseek = Boolean(deepseekApiKey)
  let runner
  let providerName
  if (mode === 'deepseek') {
    if(!hasDeepseek)throw Error('DeepSeek 搜索尚未配置 Key')
    providerName = 'deepseek'
  } else if (mode === 'baidu') {
    if(!hasBaidu)throw Error('千帆搜索尚未配置 Key')
    providerName = 'baidu'
  } else if (mode === 'dashscope') {
    if(!hasDashscope)throw Error('通义搜索尚未配置 Key')
    providerName = 'dashscope'
  } else if (mode === 'bing') {
    providerName = 'bing'
  } else if(mode==='auto') {
    providerName = hasBaidu ? 'baidu' : (hasDeepseek ? 'deepseek' : (hasDashscope ? 'dashscope' : 'bing'))
  } else throw Error('联网搜索服务商无效')
  runner = providerName === 'baidu' ? searchBaidu
    : (providerName === 'dashscope' ? searchDashscope
    : (providerName === 'deepseek' ? searchDeepseek : searchBing))

  const webSearch = async function (query) {
    const q = String(query || '').trim().slice(0, 400)
    if (!q) return { summary: '', refs: [] }
    const hit = cache.get(q)
    if (hit && Date.now() - hit.at <= CACHE_TTL_MS) return hit.value
    if (hit) cache.delete(q)
    const value = await runner(q)
    cache.set(q, { at: Date.now(), value: value })
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    return value
  }
  webSearch.providerName = providerName
  return webSearch
}
