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

/** 搜索 + 下载：依次尝试前几张，返回第一张合格图片 */
export async function findWebImage(query, { count = 10, maxBytes = 4 * 1024 * 1024, minSide = 160, minBytes = 8 * 1024, fetchImpl = (...a) => fetch(...a) } = {}) {
  const results = await searchBingImages(query, { count, fetchImpl })
  const errors = []
  for (const item of results) {
    try {
      const image = await downloadImage(item.url, { maxBytes, minSide, fetchImpl })
      if (image.buffer.length < minBytes) throw new Error('图片太小，可能是图标')
      return { ...image, sourceUrl: item.url }
    } catch (err) {
      errors.push(err.message)
    }
  }
  throw new Error('没有找到可用的图片' + (errors.length ? '：' + errors.slice(0, 2).join('；') : ''))
}
