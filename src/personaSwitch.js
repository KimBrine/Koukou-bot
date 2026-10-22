import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './stateFile.js'

// 人格目前全局生效，因此所有会话都必须建立新边界，不能只清理控制台选中的群。
export function activatePersona({ name, content, config, memory, longMemory, targetWatch, persist }) {
  if (!content.trim()) throw new Error('人格正文不能为空')
  if (config.activePersona === name && config.persona === content) return { ok: true, changed: false, persona: content }
  // 同名人格只是修改正文：只更新提示词，绝不动记忆。
  // 记忆跟着「名字」走，名字不变记忆就不变；换名字才切到另一份记忆。
  if (config.activePersona === name) {
    persist()
    config.persona = content
    config.personaRevision = (config.personaRevision || 0) + 1
    return { ok: true, changed: false, persona: content }
  }
  const recent = memory?.snapshot?.(), long = longMemory?.snapshot?.()
  const backup = (recent || long) ? path.join(config.dataDir, 'config-backups', `persona-switch-${Date.now()}-${randomUUID()}.json`) : null
  if (backup) writeJsonAtomic(backup, { time: Date.now(), from: config.activePersona || '', to: name, recent, long })
  try {
    // 人格记忆分区：切换前把当前人格的记忆存到 memory__<人格>.json / long-memory__<人格>.json，
    // 切回来时再读回来，这样换人格不会丢另一份记忆。
    const personaFile = (prefix, person) => path.join(config.dataDir, prefix + '__' + createHash('sha256').update(String(person||'')).digest('hex') + '.json')
    const readPersona = (prefix, person) => {
      let file=personaFile(prefix,person)
      // Migrate safe legacy names; never interpret a persona name as a path.
      if(!existsSync(file) && /^[^<>:"/\\|?*\x00-\x1f]{1,60}$/.test(person))file=path.join(config.dataDir,prefix+'__'+person+'.json')
      if(!existsSync(file))return null
      const value=JSON.parse(readFileSync(file,'utf8'))
      if(!value || typeof value.chats!=='object' || Array.isArray(value.chats))throw Error('人格记忆分区格式错误')
      return value
    }
    const from=config.activePersona||''
    // Read the target before changing either runtime store.
    const targetRecent=readPersona('memory',name),targetLong=readPersona('long-memory',name)
    if(recent)writeJsonAtomic(personaFile('memory',from),recent)
    if(long)writeJsonAtomic(personaFile('long-memory',from),long)
    memory?.clear?.();longMemory?.clear?.()
    if(targetRecent)memory?.restore?.({...targetRecent,resetAt:Math.floor(Date.now()/1000)*1000,keyResetAt:{}})
    if(targetLong)longMemory?.restore?.(targetLong)
    persist()
  } catch (err) {
    const failures = []
    for (const [service, value] of [[memory, recent], [longMemory, long]]) {
      if (value) { try { service.restore(value) } catch (restoreError) { failures.push(restoreError.message) } }
    }
    throw new Error(`人格切换未完成：${err.message}${failures.length ? `；记忆恢复需检查备份：${failures.join('；')}` : '；原记忆已保留'}`)
  }
  config.activePersona = name; config.persona = content
  config.personaRevision = (config.personaRevision || 0) + 1
  targetWatch?.resetPending?.()
  return { ok: true, changed: true, persona: content, reset: {
    chats: Object.keys(recent?.chats || {}).length,
    messages: Object.values(recent?.chats || {}).reduce((n, items) => n + items.length, 0),
    longChats: Object.keys(long?.chats || {}).length,
    backedUp: Boolean(backup),
  } }
}
