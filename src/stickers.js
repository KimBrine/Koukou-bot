import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { writeJsonAtomic, quarantineCorrupt } from './stateFile.js'

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

export const STICKER_LIBRARY_LIMIT = 60
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
  const blockedDir = path.join(dir, 'blacklist-images')
  const blockedFile = hash => path.join(blockedDir, hash)
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
  const learningFile = path.join(dir, 'learning-state.json')
  // 学习状态读坏了不能让整只机器人起不来：按"未暂停"继续，坏文件留档。
  let pausedByCapacity = false
  if (existsSync(learningFile)) {
    try { pausedByCapacity = JSON.parse(readFileSync(learningFile, 'utf8')).pausedByCapacity === true }
    catch (err) {
      const kept = quarantineCorrupt(learningFile)
      logger?.warn?.(`表情包学习状态损坏${kept ? '，已另存为 ' + kept : ''}，按未暂停继续：${err.message}`)
      pausedByCapacity = false
    }
  }
  function lockLearning() {
    if (!pausedByCapacity) { writeJsonAtomic(learningFile, { pausedByCapacity: true }); pausedByCapacity = true }
  }
  function learningStatus() {
    if (items.length >= STICKER_LIBRARY_LIMIT) lockLearning()
    return { limit: STICKER_LIBRARY_LIMIT, full: items.length >= STICKER_LIBRARY_LIMIT, pausedByCapacity }
  }
  function learningAllowed() { const state = learningStatus(); return !state.full && !state.pausedByCapacity }
  function resumeLearning() {
    if (items.length >= STICKER_LIBRARY_LIMIT) throw new Error('当前人格图库已满60张，请先人工清理后再开启学习')
    writeJsonAtomic(learningFile, { pausedByCapacity: false }); pausedByCapacity = false
  }
  learningStatus()
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
    if (items.length >= STICKER_LIBRARY_LIMIT) { lockLearning(); throw new Error('当前人格图库已满60张，请先人工清理') }
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
    try { save() } catch (error) { items.pop(); try { unlinkSync(path.join(dir, file)) } catch {}; throw error }
    learningStatus()
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
    // 独立归档仅供控制台预览；不进入选图、模型清单或发送接口。
    const buffer = readFileSync(fileOf(item))
    if (createHash('sha256').update(buffer).digest('hex') !== item.hash) throw new Error('图片哈希不一致，未加入黑名单')
    mkdirSync(blockedDir, {recursive:true})
    writeFileSync(blockedFile(item.hash), buffer)
    const next = [...blocked.filter(x => x.hash !== item.hash), {hash:item.hash, name:item.name, keywords:item.keywords, description:item.description, mime:item.mime, size:buffer.length, blockedAt:now()}]
    writeJsonAtomic(blacklistFile, next)
    blocked = next
    // 先保存黑名单，再移除活动库索引和图片；重启及在途学习不能重新收录。
    remove(id)
    return true
  }
  function unblock(hash) {
    const next = blocked.filter(x => x.hash !== hash)
    if (next.length === blocked.length) return false
    writeJsonAtomic(blacklistFile, next)
    blocked = next
    try { unlinkSync(blockedFile(hash)) } catch { /* 旧记录可能没有预览 */ }
    return true
  }

  function blacklistImage(hash) {
    if (!/^[a-f0-9]{64}$/.test(String(hash)) || !isBlocked(hash)) return null
    const entry=blocked.find(x=>x.hash===hash)
    try {
      const buffer=readFileSync(blockedFile(hash))
      if(createHash('sha256').update(buffer).digest('hex')!==hash)return null
      return {buffer,mime:ALLOWED[entry.mime]?entry.mime:'application/octet-stream'}
    } catch { return null }
  }

  // 旧版只保留哈希：按完整 SHA-256 从已有图片缓存找回预览，不下载、不重新入库。
  for (const entry of blocked) {
    if(existsSync(blockedFile(entry.hash)))continue
    try {
      const buffer=readFileSync(path.join(dir,'..','image-cache',entry.hash+'.bin'))
      if(buffer.length>STICKER_MAX_BYTES||createHash('sha256').update(buffer).digest('hex')!==entry.hash)continue
      const mime=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':buffer[0]===255&&buffer[1]===216?'image/jpeg':buffer.subarray(0,3).toString()==='GIF'?'image/gif':buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP'?'image/webp':null
      if(!mime)continue
      mkdirSync(blockedDir,{recursive:true});writeFileSync(blockedFile(entry.hash),buffer)
      Object.assign(entry,{mime,size:buffer.length})
      writeJsonAtomic(blacklistFile,blocked)
    } catch { /* 缓存已过期则保留黑名单并显示无预览 */ }
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

  /** 匹配程度分档；不使用使用次数、加入时间或列表位置作为权重。 */
  function candidates(queries) {
    const clean = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '').trim()
    const dice = (a,b) => {
      if(a.length < 2 || b.length < 2) return 0
      const grams = x => new Set(Array.from({length:x.length-1},(_,i)=>x.slice(i,i+2)))
      const x=grams(a),y=grams(b);return 2*[...x].filter(g=>y.has(g)).length/(x.size+y.size)
    }
    const qs=[...new Set((Array.isArray(queries)?queries:[queries]).map(clean).filter(Boolean))]
    return items.map(item=>{
      const name=clean(item.name), id=clean(item.id)
      const words=[name,...(item.keywords||[]).map(clean),...(item.scenes||[]).map(id=>clean(STICKER_SCENES.find(s=>s.id===id)?.name||id))].filter(Boolean)
      let weight=0
      for(const q of qs){
        let score=q===id||q===name?1.7:words.includes(q)?1.5:0
        if(words.some(w=>w.includes(q)||(w.length>=2&&q.includes(w))))score=Math.max(score,1.2)
        if(words.some(w=>w.length===1&&q.includes(w)))score=Math.max(score,1.0)
        if(q.length>=2){
          if(words.some(w=>dice(q,w)>=0.5))score=Math.max(score,1.0)
        }
        weight=Math.max(weight,score)
      }
      return {item,weight}
    }).filter(x=>x.weight>0)
  }
  function choose(queries,{limit=1,rand=Math.random}={}) {
    const pool=candidates(queries),out=[]
    while(pool.length&&out.length<limit){
      let roll=rand()*pool.reduce((n,x)=>n+x.weight,0),index=pool.length-1
      for(let i=0;i<pool.length;i++){roll-=pool[i].weight;if(roll<0){index=i;break}}
      out.push(pool.splice(index,1)[0].item)
    }
    return out
  }
  /** 管理调用仍可精确定位ID；选图统一按匹配权重抽取，支持同名。 */
  function find(query,{exact=false,rand=Math.random}={}) {
    if(exact)return items.find(item=>String(item.name).toLowerCase()===String(query).trim().toLowerCase()||item.id===query)||null
    return choose([query],{rand})[0]||null
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

  /** 明确索图未给候选时按语境加权；没有匹配才随机兜底。 */
  function pick(contextText) { return choose([contextText])[0] || random() }

  function random() {
    if (items.length === 0) return null
    return items[Math.floor(Math.random() * items.length)]
  }

  /** 给模型看的元数据清单；使用次数只供管理查看，不代表语境正确。 */
  function summary(limit = 20) {
    if (items.length === 0) return ''
    return items.slice(0, limit).map((x) => x.name + ((x.keywords || []).length ? `(${x.keywords.join('/')})` : '') + ((x.scenes||[]).length?`[场景:${x.scenes.map(id=>STICKER_SCENES.find(s=>s.id===id)?.name||id).join('/')}]`:'') + (x.description ? `：${x.description.slice(0,240)}` : '')).join('；')
  }

  function dataUrlOf(item) {
    if (!item || !items.some(x => x.id === item.id && x.hash === item.hash && x.file === item.file) || isBlocked(item.hash)) return null
    try {
      const buf = readFileSync(fileOf(item))
      return `base64://${buf.toString('base64')}`
    } catch { return null }
  }

  return { dir, list, get, add, remove, update, find, pick, random, noteUsage, summary, dataUrlOf, blacklist, unblock, isBlocked, blacklistImage, choose, candidates, learningStatus, learningAllowed, resumeLearning,
    blacklistEntries: () => blocked.map(x=>({...x,hasPreview:existsSync(blockedFile(x.hash))})).sort((a,b)=>b.blockedAt-a.blockedAt), count: () => items.length,
    learned: () => items.filter((x) => x.origin === 'learned').length }
}

/** 从一段文字里取出 [贴纸: xxx] 标记，返回去掉标记的文本与按顺序的查询词 */
export function extractStickerMarkers(text) {
  const queries = []
  let requested=false
  const cleaned = String(text || '').replace(/\[索要表情包\]/g,()=>{requested=true;return ''}).replace(/\[贴纸[:：]\s*([^\]\n]{1,40})\]/g, (_, q) => {
    const v = String(q).trim()
    if (v) queries.push(v)
    return ''
  }).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim()
  return { text: cleaned, queries, requested }
}
