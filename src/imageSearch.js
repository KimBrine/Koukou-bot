/**
 * 联网找图：必应图片搜索（HTML 异步接口，不需要 Key）。
 *
 * 只取图片直链，不做内容审核；调用方负责大小/类型校验和"只发合格图片"。
 * 这是给"给我找张表情包"用的，和 models 的联网搜索（文字/链接）是两条路。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const ALLOWED_MIME = ['png', 'jpeg', 'webp', 'gif']

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** 从必应图片 HTML 里抽 murl（图片直链），去重并过滤非 http(s) */
export function parseBingImageResults(html, limit = 10) {
  const out = [], seen = new Set()
  const re = /murl&quot;:&quot;([^&"]+)&quot;/g
  for (const m of String(html || '').matchAll(re)) {
    const url = decodeEntities(m[1])
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({ url })
    if (out.length >= limit) break
  }
  return out
}

/** 把用户原话压成搜索词：「给我找张开心的表情包」→「开心 表情包」 */
export function buildStickerQuery(text) {
  const cleaned = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/(?:帮我|给我|麻烦|请|你|能不能|可以|再|来|发|找|搜|一张|张|个|点|一些|几|网上|联网|在线|的|吧|呀|啊|嘛|呢|下)/gu, ' ')
    .replace(/[，。！？、,.!?~～\s]+/g, ' ')
    .trim()
  const base = /表情包|贴纸/.test(cleaned) ? '' : ' 表情包'
  return (cleaned || '表情') + base
}

export async function searchBingImages(query, { count = 10, fetchImpl = (...a) => fetch(...a), timeoutMs = 8000 } = {}) {
  const url = 'https://www.bing.com/images/async?q=' + encodeURIComponent(String(query || '表情包'))
    + '&first=1&count=' + Math.max(1, Math.min(35, Number(count) || 10)) + '&mkt=zh-CN&adlt=off'
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('图片搜索失败（HTTP ' + res.status + '）')
  return parseBingImageResults(await res.text(), count)
}

/** 读图片宽高（PNG/GIF/JPEG；WebP 等读不出就返回 null，不做尺寸门槛） */
export function imageSize(buffer) {
  try {
    if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (buffer.length > 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let i = 2
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) { i++; continue }
        const marker = buffer[i + 1]
        const size = buffer.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) }
        }
        i += 2 + size
      }
    }
  } catch { /* 解析失败不做门槛 */ }
  return null
}

/** 下载并校验图片；返回可直接交给 OneBot 的 data URL */
export async function downloadImage(url, { maxBytes = 4 * 1024 * 1024, minSide = 0, fetchImpl = (...a) => fetch(...a), timeoutMs = 10000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, accept: 'image/*' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error('图片下载失败（HTTP ' + res.status + '）')
  const type = String(res.headers.get('content-type') || '').toLowerCase()
  const mime = ALLOWED_MIME.find((x) => type.includes('image/' + x))
  if (!mime) throw new Error('不是支持的图片类型：' + (type || '未知'))
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error('图片太大（' + (buffer.length / 1024 / 1024).toFixed(1) + 'MB）')
  if (buffer.length < 1024) throw new Error('图片太小，可能是占位图')
  const size = imageSize(buffer)
  if (minSide > 0 && size && (size.width < minSide || size.height < minSide)) {
    throw new Error('图片尺寸太小（' + size.width + '×' + size.height + '）')
  }
  return { buffer, mime: 'image/' + mime, size, dataUrl: `data:image/${mime};base64,${buffer.toString('base64')}` }
}

/** 从任意 JSON 里递归收集图片直链（自定义接口用；只看扩展名明确的 http(s) URL） */
export function collectImageUrls(node, out = [], depth = 0) {
  if (depth > 4 || out.length >= 40) return out
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node) && /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(node)) out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectImageUrls(item, out, depth + 1)
    return out
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectImageUrls(value, out, depth + 1)
  }
  return out
}

/**
 * 自定义图片搜索：URL 模板里可用 {query} {key} {count} 占位符，返回 JSON 后递归找图片直链。
 * 例：https://api.example.com/images?q={query}&limit={count}&key={key}
 */
export async function searchCustomImages(query, { urlTemplate = '', key = '', count = 10, fetchImpl = (...a) => fetch(...a), timeoutMs = 10000 } = {}) {
  const template = String(urlTemplate || '').trim()
  if (!template) throw new Error('自定义搜图接口还没填 URL')
  const url = template
    .replace(/\{query\}/g, encodeURIComponent(String(query || '')))
    .replace(/\{key\}/g, encodeURIComponent(String(key || '')))
    .replace(/\{count\}/g, String(Math.max(1, Math.min(35, Number(count) || 10))))
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('自定义搜图接口返回 HTTP ' + res.status)
  let data
  try { data = await res.json() } catch { throw new Error('自定义搜图接口没有返回 JSON') }
  const urls = [...new Set(collectImageUrls(data))]
  return urls.slice(0, count).map((u) => ({ url: u }))
}

/** Giphy 表情包搜索（结果天生是 sticker/GIF，需要 Key） */
export async function searchGiphy(query, { key = '', count = 10, fetchImpl = (...a) => fetch(...a), timeoutMs = 10000 } = {}) {
  if (!String(key || '').trim()) throw new Error('Giphy 需要先在设置里填 API Key')
  const url = 'https://api.giphy.com/v1/stickers/search?api_key=' + encodeURIComponent(key)
    + '&q=' + encodeURIComponent(String(query || '')) + '&limit=' + Math.max(1, Math.min(35, Number(count) || 10)) + '&rating=pg-13&lang=zh-CN'
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('Giphy 返回 HTTP ' + res.status)
  const data = await res.json().catch(() => null)
  return (Array.isArray(data?.data) ? data.data : [])
    .map((item) => item?.images?.original?.url || item?.images?.fixed_width?.url || '')
    .filter(Boolean).slice(0, count).map((url) => ({ url }))
}

/** Tenor 表情包搜索（v2 API，需要 Key） */
export async function searchTenor(query, { key = '', count = 10, fetchImpl = (...a) => fetch(...a), timeoutMs = 10000 } = {}) {
  if (!String(key || '').trim()) throw new Error('Tenor 需要先在设置里填 API Key')
  const url = 'https://tenor.googleapis.com/v2/search?key=' + encodeURIComponent(key)
    + '&q=' + encodeURIComponent(String(query || '')) + '&limit=' + Math.max(1, Math.min(35, Number(count) || 10)) + '&media_filter=gif'
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('Tenor 返回 HTTP ' + res.status)
  const data = await res.json().catch(() => null)
  return (Array.isArray(data?.results) ? data.results : [])
    .map((item) => item?.media_formats?.gif?.url || item?.media_formats?.tinygif?.url || '')
    .filter(Boolean).slice(0, count).map((url) => ({ url }))
}

/** 统一入口：按配置选择搜索来源 */
export function searchImages(query, { provider = 'bing', urlTemplate = '', key = '', count = 10, fetchImpl = (...a) => fetch(...a) } = {}) {
  if (provider === 'custom') return searchCustomImages(query, { urlTemplate, key, count, fetchImpl })
  if (provider === 'giphy') return searchGiphy(query, { key, count, fetchImpl })
  if (provider === 'tenor') return searchTenor(query, { key, count, fetchImpl })
  return searchBingImages(query, { count, fetchImpl })
}

/** 多个搜索词依次搜 + 下载校验，返回最多 limit 张可用图片 */
export async function collectWebImages(queries, {
  provider = 'bing', urlTemplate = '', key = '', limit = 6, count = 8,
  minSide = 160, minBytes = 8 * 1024, maxBytes = 4 * 1024 * 1024,
  fetchImpl = (...a) => fetch(...a),
} = {}) {
  const images = [], seen = new Set()
  for (const query of queries) {
    let results = []
    try { results = await searchImages(query, { provider, urlTemplate, key, count, fetchImpl }) }
    catch { continue }
    for (const item of results) {
      if (images.length >= limit) return images
      if (!item?.url || seen.has(item.url)) continue
      seen.add(item.url)
      try {
        const image = await downloadImage(item.url, { maxBytes, minSide, fetchImpl })
        if (image.buffer.length < minBytes) continue
        images.push({ ...image, sourceUrl: item.url, query })
      } catch { /* 这张不合格，继续下一张 */ }
    }
  }
  return images
}

/** 搜索 + 下载：依次尝试前几张，返回第一张合格图片 */
export async function findWebImage(query, { count = 10, maxBytes = 4 * 1024 * 1024, minSide = 160, minBytes = 8 * 1024, fetchImpl = (...a) => fetch(...a) } = {}) {
  const images = await collectWebImages([query], { count, maxBytes, minSide, minBytes, limit: 1, fetchImpl })
  if (!images.length) throw new Error('没有找到可用的图片')
  return images[0]
}
