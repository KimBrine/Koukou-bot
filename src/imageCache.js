import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs'
import path from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
const validHash = value => /^[a-f0-9]{64}$/.test(String(value))
const DAY = 86400000

/** QQ 的文件 MD5 / fileid 比带过期 rkey 的下载地址稳定。普通 URL 保留完整查询串。 */
export function imageReferenceKeys(img) {
  const refs = []
  const file = String(img?.file ?? '')
  const md5 = /^(?:\{)?([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\})?(?:\.(?:image|png|jpe?g|gif|webp))?$/i.exec(file)
  if (md5) refs.push(`qq-md5:${md5[1].replace(/-/g, '').toLowerCase()}`)
  if (img?.url) {
    try {
      const url = new URL(img.url)
      if (url.hostname === 'gchat.qpic.cn' || url.hostname === 'multimedia.nt.qq.com.cn') {
        const fileid = url.searchParams.get('fileid')
        if (fileid) refs.push(`qq-fileid:${url.hostname}:${url.pathname}:${url.searchParams.get('appid') ?? ''}:${fileid}:${url.searchParams.get('spec') ?? ''}`)
        else if (/\/gchatpic_new\//.test(url.pathname)) refs.push(`qq-path:${url.origin}${url.pathname}`)
      }
      refs.push(`url:${url.href}`)
    } catch { /* 无效地址交给下载流程处理 */ }
  }
  // 索引不保存带鉴权参数的原链接。
  return [...new Set(refs.map(digest))]
}

export function imagePartHash(part) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(part?.image_url?.url ?? '')
  if (!match) throw new Error('图片缓存只接受已下载的有效图片')
  const bytes = Buffer.from(match[2], 'base64')
  return { hash: digest(bytes), mime: match[1], bytes }
}

export function createImageCache({ dir, maxBytes = 256 * 1024 * 1024, maxEntries = 2000, maxImageBytes = 6 * 1024 * 1024, ttlMs = 30 * DAY, logger, now = Date.now }) {
  const root = path.resolve(dir)
  const indexFile = path.join(root, 'index.json')
  const images = new Map()
  const aliases = new Map()
  const descriptions = new Map()
  const loading = new Map()
  const describing = new Map()
  const counters = { imageHits: 0, descriptionHits: 0 }
  const warn = err => logger?.warn?.(`[图片缓存] ${err.message}`)
  const imageFile = hash => path.join(root, `${hash}.bin`)
  let dirty = false

  function remove(hash) {
    const item = images.get(hash)
    images.delete(hash)
    for (const key of item?.aliases ?? []) if (aliases.get(key) === hash) aliases.delete(key)
    for (const [key, value] of descriptions) if (value.hashes.includes(hash)) descriptions.delete(key)
    // hash 经过格式校验；只删除本缓存目录下对应的单个文件。
    try { if (validHash(hash) && existsSync(imageFile(hash))) unlinkSync(imageFile(hash)) } catch (err) { warn(err) }
    dirty = true
  }

  function prune() {
    for (const [hash, item] of images) if (now() - item.usedAt > ttlMs) remove(hash)
    const ordered = [...images.values()].sort((a, b) => a.usedAt - b.usedAt)
    let bytes = ordered.reduce((sum, item) => sum + item.size, 0)
    for (const item of ordered) {
      if (bytes <= maxBytes && images.size <= maxEntries) break
      bytes -= item.size
      remove(item.hash)
    }
    for (const [key, item] of descriptions) {
      if (now() - item.usedAt > ttlMs || item.hashes.some(hash => !images.has(hash))) { descriptions.delete(key); dirty = true }
    }
    const descOrder = [...descriptions].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [key] of descOrder.slice(0, Math.max(0, descriptions.size - maxEntries))) { descriptions.delete(key); dirty = true }
  }

  function save() {
    if (!dirty) return
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(`${indexFile}.tmp`, JSON.stringify({ version: 1, images: [...images.values()], descriptions: [...descriptions] }))
      renameSync(`${indexFile}.tmp`, indexFile)
      dirty = false
    } catch (err) { warn(err) }
  }

  try {
    if (existsSync(indexFile)) {
      const data = JSON.parse(readFileSync(indexFile, 'utf8'))
      for (const item of data.images ?? []) {
        if (!validHash(item.hash) || !/^image\/(png|jpeg|gif|webp)$/.test(item.mime) || !Number.isFinite(item.size) || !Number.isFinite(item.usedAt) || !existsSync(imageFile(item.hash))) continue
        item.aliases = (Array.isArray(item.aliases) ? item.aliases : []).filter(validHash).slice(-64)
        images.set(item.hash, item)
        for (const key of item.aliases) aliases.set(key, item.hash)
      }
      for (const [key, item] of data.descriptions ?? []) {
        if (validHash(key) && Array.isArray(item.hashes) && item.hashes.every(validHash) && Number.isFinite(item.usedAt) && typeof item.text === 'string' && item.text.trim()) descriptions.set(key, item)
      }
      prune()
      save()
    }
  } catch (err) { warn(err) }
  // 上次写入中断时可能留下无索引文件；仅清理本目录里符合内容哈希命名的缓存。
  try {
    if (existsSync(root)) for (const name of readdirSync(root)) {
      const match = /^([a-f0-9]{64})\.bin$/.exec(name)
      if (match && !images.has(match[1])) unlinkSync(imageFile(match[1]))
    }
  } catch (err) { warn(err) }

  function touch(item, refs) {
    item.usedAt = now()
    for (const key of refs) {
      if (!item.aliases.includes(key)) item.aliases.push(key)
      aliases.set(key, item.hash)
    }
    while (item.aliases.length > 64) {
      const key = item.aliases.shift()
      if (aliases.get(key) === item.hash) aliases.delete(key)
    }
    dirty = true
  }

  async function load(img, download) {
    prune()
    save()
    const refs = imageReferenceKeys(img)
    for (const ref of refs) {
      const hash = aliases.get(ref)
      const item = images.get(hash)
      if (!item) continue
      if (item.size > maxImageBytes) throw new Error(`图片超过识图大小上限（${maxImageBytes} 字节）`)
      if (now() - item.usedAt > ttlMs) { remove(hash); continue }
      try {
        const bytes = readFileSync(imageFile(hash))
        if (digest(bytes) !== hash) throw new Error('缓存内容校验失败，重新获取')
        touch(item, refs)
        save()
        counters.imageHits++
        logger?.info?.(`[图片缓存] 命中 ${hash.slice(0, 12)}，跳过下载`)
        return { hash, part: { type: 'image_url', image_url: { url: `data:${item.mime};base64,${bytes.toString('base64')}` } } }
      } catch (err) { warn(err); remove(hash) }
    }
    const flight = refs.find(ref => loading.has(ref))
    if (flight) {
      const result = await loading.get(flight)
      if (result && images.has(result.hash)) { touch(images.get(result.hash), refs); save() }
      return result
    }
    const promise = (async () => {
      const part = await download()
      if (!part) return null
      const { hash, mime, bytes } = imagePartHash(part)
      if (bytes.length <= maxBytes) {
        try {
          mkdirSync(root, { recursive: true })
          if (!images.has(hash)) {
            writeFileSync(imageFile(hash), bytes)
            images.set(hash, { hash, mime, size: bytes.length, usedAt: now(), aliases: [] })
          }
          touch(images.get(hash), refs)
          prune()
          save()
        } catch (err) { warn(err) }
      }
      return { hash, part }
    })()
    for (const ref of refs) loading.set(ref, promise)
    try { return await promise }
    finally { for (const ref of refs) if (loading.get(ref) === promise) loading.delete(ref) }
  }

  async function describe(hashes, scope, generate) {
    const key = digest(JSON.stringify([scope, hashes]))
    const previous = descriptions.get(key)
    if (previous && now() - previous.usedAt <= ttlMs && hashes.every(hash => images.has(hash))) {
      previous.usedAt = now()
      dirty = true
      save()
      counters.descriptionHits++
      logger?.info?.('[识图缓存] 命中图片描述，跳过视觉模型调用')
      return previous.text
    }
    if (describing.has(key)) return describing.get(key)
    const promise = (async () => {
      const text = String(await generate() ?? '').trim()
      if (!text) throw new Error('识图接口返回空描述')
      if (hashes.length && hashes.every(hash => images.has(hash))) {
        descriptions.set(key, { hashes, text, usedAt: now() })
        dirty = true
        prune()
        save()
      }
      return text
    })()
    describing.set(key, promise)
    try { return await promise }
    finally { describing.delete(key) }
  }

  return { load, describe, stats: () => ({ ...counters, images: images.size, descriptions: descriptions.size, bytes: [...images.values()].reduce((sum, item) => sum + item.size, 0) }) }
}
