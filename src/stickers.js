import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './stateFile.js'

/** 单张表情包上限 4MB：QQ 图片接口对超大图不友好，也避免把磁盘撑爆 */
/** 常用语境标签：既方便手动分类，也让模型按语境挑图 */
export const STICKER_SCENES = [
  { id: 'happy', name: '开心' },
  { id: 'like', name: '喜欢/赞同' },
  { id: 'shy', name: '害羞/卖萌' },
  { id: 'laugh', name: '笑/无语' },
  { id: 'sad', name: '难过/求安慰' },
  { id: 'angry', name: '生气/吐槽' },
  { id: 'tired', name: '累/困' },
  { id: 'question', name: '疑惑' },
  { id: 'bye', name: '告别' },
  { id: 'other', name: '其他' },
]

export const STICKER_MAX_BYTES = 4 * 1024 * 1024
const ALLOWED = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || '').trim())
  if (!m) throw new Error('只支持 PNG / JPEG / WebP / GIF 图片')
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
  if (buf.length === 0) throw new Error('图片内容为空')
  if (buf.length > STICKER_MAX_BYTES) throw new Error(`图片太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），上限 ${STICKER_MAX_BYTES / 1024 / 1024}MB`)
  return { mime: m[1], buffer: buf }
}

/**
 * 表情包库：索引存在 <dir>/stickers.json，图片本体存 <dir>/<hash>.<ext>。
 * - 同一张图重复上传会被哈希识别，直接复用；
 * - 关键词用于模型输出 [贴纸: 关键词] 时匹配，按名称/关键词做包含匹配。
 */
export function createStickers({ dir, logger, now = () => Date.now() }) {
  mkdirSync(dir, { recursive: true })
  const indexFile = path.join(dir, 'stickers.json')
  const blacklistFile = path.join(dir, 'blacklist.json')
  // 读取失败时停止初始化，不能把损坏的黑名单当成空名单重新采集。
  let blocked = existsSync(blacklistFile) ? JSON.parse(readFileSync(blacklistFile, 'utf8')) : []
  if (!Array.isArray(blocked) || blocked.some(x => !/^[a-f0-9]{64}$/.test(x?.hash))) throw new Error('表情包黑名单格式错误，请恢复备份')
  const isBlocked = hash => blocked.some(x => x.hash === hash)
  let items = []
  try {
    if (existsSync(indexFile)) {
      const parsed = JSON.parse(readFileSync(indexFile, 'utf8'))
      items = Array.isArray(parsed) ? parsed.filter((x) => x && x.id && x.file) : []
    }
  } catch (err) {
    logger?.warn?.(`表情包索引读取失败，按空库处理：${err.message}`)
  }

  const save = () => { writeJsonAtomic(indexFile, items) }

  function normalizeItem(raw) {
    const item = { ...raw }
    item.scenes = Array.isArray(raw.scenes) ? raw.scenes.filter((s) => STICKER_SCENES.some((x) => x.id === s)) : []
    item.description = String(raw.description || '').slice(0,1000)
    item.origin = raw.origin === 'learned' ? 'learned' : 'manual'
    item.usage = Number.isFinite(raw.usage) ? raw.usage : 0
    item.lastContexts = Array.isArray(raw.lastContexts) ? raw.lastContexts.slice(0, 8) : []
    return item
  }
  items = items.map(normalizeItem).filter(x => !isBlocked(x.hash))
  const list = () => items.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
  const get = (id) => items.find((x) => x.id === id) || null
  const fileOf = (item) => path.join(dir, item.file)

  function add({ name, keywords, scenes, dataUrl, origin, source, description } = {}) {
    const { mime, buffer } = parseDataUrl(dataUrl)
    const hash = createHash('sha256').update(buffer).digest('hex')
    if (isBlocked(hash)) throw new Error('这张图片已在表情包黑名单中，请先解除黑名单')
    const exists = items.find((x) => x.hash === hash)
    const label = String(name || '').trim().slice(0, 40)
    if (exists) {
      if (label && exists.name !== label) { exists.name = label; save() }
      return { item: exists, duplicated: true }
    }
    const ext = ALLOWED[mime]
    const file = `${hash.slice(0, 16)}.${ext}`
    writeFileSync(path.join(dir, file), buffer)
    const item = {
      id: randomUUID().slice(0, 8),
      description: String(description || '').trim().slice(0,1000),
      name: label || `表情${items.length + 1}`,
      keywords: String(keywords || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12),
      scenes: Array.isArray(scenes) ? scenes.filter((s) => STICKER_SCENES.some((x) => x.id === s)) : [],
      file,
      mime,
      size: buffer.length,
      hash,
      origin: origin === 'learned' ? 'learned' : 'manual',
      source: source ? String(source).slice(0, 120) : '',
      usage: 0,
      lastContexts: [],
      addedAt: now(),
    }
    items.push(item)
    save()
    logger?.info?.(`[表情包] 新增「${item.name}」（${(buffer.length / 1024).toFixed(0)}KB）`)
    return { item, duplicated: false }
  }

  function remove(id) {
    const idx = items.findIndex((x) => x.id === id)
    if (idx < 0) return false
    const [item] = items.splice(idx, 1)
    try { save() } catch(error) { items.splice(idx, 0, item); throw error }
    try { unlinkSync(path.join(dir, item.file)) } catch { /* 文件可能已被手工删除 */ }
    return true
  }

  function blacklist(id) {
    const item = get(id)
    if (!item) return false
    const next = [...blocked.filter(x => x.hash !== item.hash), {hash:item.hash, name:item.name, blockedAt:now()}]
    writeJsonAtomic(blacklistFile, next)
    blocked = next
    // 先保存黑名单，再移除索引和图片；重启及正在进行的学习都不能重新收录。
    remove(id)
    return true
  }
  function unblock(hash) {
    const next = blocked.filter(x => x.hash !== hash)
    if (next.length === blocked.length) return false
    writeJsonAtomic(blacklistFile, next)
    blocked = next
    return true
  }

  function update(id, { name, keywords, scenes, description, dataUrl } = {}) {
    const item = get(id)
    if (!item) return null
    const next={...item}
    if(name!==undefined)next.name=String(name).trim().slice(0,40)||item.name
    if(keywords!==undefined)next.keywords=String(keywords).split(/[,，\s]+/).filter(Boolean).slice(0,12)
    if(scenes!==undefined)next.scenes=(Array.isArray(scenes)?scenes:[]).filter(s=>STICKER_SCENES.some(x=>x.id===s))
    if(description!==undefined)next.description=String(description).trim().slice(0,1000)
    let newFile=null
    if(dataUrl){
      const {mime,buffer}=parseDataUrl(dataUrl),hash=createHash('sha256').update(buffer).digest('hex')
      if(isBlocked(hash))throw new Error('这张图片已在表情包黑名单中，请先解除黑名单')
      if(items.some(x=>x.id!==id&&x.hash===hash))throw new Error('这张图片已存在于另一条表情包，请编辑已有条目')
      newFile=`${hash.slice(0,16)}.${ALLOWED[mime]}`
      if(newFile!==item.file)writeFileSync(path.join(dir,newFile),buffer)
      Object.assign(next,{file:newFile,hash,mime,size:buffer.length})
    }
    const index=items.indexOf(item);items[index]=next
    try{save()}catch(error){items[index]=item;if(newFile&&newFile!==item.file)try{unlinkSync(path.join(dir,newFile))}catch{};throw error}
    if(newFile&&newFile!==item.file)try{unlinkSync(fileOf(item))}catch{}
    return next
  }

  /** 按名称/关键词匹配；都匹配不到返回 null（不猜） */
  function find(query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return null
    const score = (item) => {
      const name = String(item.name || '').toLowerCase()
      const kws = (item.keywords || []).map((k) => String(k).toLowerCase())
      if (name === q) return 100
      if (kws.includes(q)) return 90
      if (name.includes(q)) return 70
      if (kws.some((k) => k.includes(q) || q.includes(k))) return 50
      const scenes = (item.scenes || [])
      const sceneName = scenes.map((id) => STICKER_SCENES.find((x) => x.id === id)?.name || '').filter(Boolean)
      if (sceneName.some((n) => n === q)) return 60
      if (sceneName.some((n) => n.includes(q) || q.includes(n))) return 40
      return 0
    }
    let best = null
    let bestScore = 0
    for (const item of items) {
      const s = score(item)
      if (s > bestScore) { best = item; bestScore = s }
    }
    return best
  }

  /** 记住「这张图上次用在哪句话后面」，用于以后按语境挑图 */
  function noteUsage(id, contextText) {
    const item = get(id)
    if (!item) return false
    const ctx = String(contextText || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    item.usage = (item.usage || 0) + 1
    if (ctx) {
      item.lastContexts = [ctx, ...(item.lastContexts || []).filter((c) => c !== ctx)].slice(0, 8)
    }
    save()
    return true
  }

  /** 按语境挑一张：关键词/场景命中优先，其次看历史语境相似度，最后随机 */
  function pick(contextText) {
    if (items.length === 0) return null
    const ctx = String(contextText || '')
    if (!ctx.trim()) return random()
    // 1) 语境里直接出现名称/关键词/场景名
    for (const item of items) {
      const words = [item.name, ...(item.keywords || [])]
      const sceneNames = (item.scenes || []).map((id) => STICKER_SCENES.find((x) => x.id === id)?.name || '').filter(Boolean)
      if ([...words, ...sceneNames].some((w) => w && ctx.includes(w))) return item
    }
    // 2) 历史语境相似度（按两字片段重合打分）
    const grams = (s) => {
      const out = new Set()
      const clean = s.replace(/\s+/g, '')
      for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2))
      return out
    }
    const ctxGrams = grams(ctx)
    let best = null
    let bestScore = 0
    for (const item of items) {
      for (const past of item.lastContexts || []) {
        let hit = 0
        for (const g of grams(past)) if (ctxGrams.has(g)) hit++
        const score = hit / Math.max(4, grams(past).size)
        if (score > bestScore) { best = item; bestScore = score }
      }
    }
    if (best && bestScore >= 0.34) return best
    // 3) 退化成随机
    return random()
  }

  function random() {
    if (items.length === 0) return null
    return items[Math.floor(Math.random() * items.length)]
  }

  /** 给模型看的一句话清单（太多会撑提示词，只取前 20 个） */
  function summary(limit = 20) {
    if (items.length === 0) return ''
    return items.slice(0, limit).map((x) => x.name + ((x.keywords || []).length ? `(${x.keywords.slice(0, 3).join('/')})` : '') + (x.description ? `：${x.description.slice(0,80)}` : '')).join('、')
  }

  function dataUrlOf(item) {
    if (!item || isBlocked(item.hash)) return null
    try {
      const buf = readFileSync(fileOf(item))
      return `base64://${buf.toString('base64')}`
    } catch { return null }
  }

  return { dir, list, get, add, remove, update, find, pick, random, noteUsage, summary, dataUrlOf, blacklist, unblock, isBlocked,
    blacklistEntries: () => blocked.map(x=>({...x})).sort((a,b)=>b.blockedAt-a.blockedAt), count: () => items.length,
    learned: () => items.filter((x) => x.origin === 'learned').length }
}

/** 从一段文字里取出 [贴纸: xxx] 标记，返回去掉标记的文本与按顺序的查询词 */
export function extractStickerMarkers(text) {
  const queries = []
  const cleaned = String(text || '').replace(/\[贴纸[:：]\s*([^\]\n]{1,40})\]/g, (_, q) => {
    const v = String(q).trim()
    if (v) queries.push(v)
    return ''
  }).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim()
  return { text: cleaned, queries }
}
