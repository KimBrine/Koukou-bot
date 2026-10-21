import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './stateFile.js'

// 人格目前全局生效，因此所有会话都必须建立新边界，不能只清理控制台选中的群。
export function activatePersona({ name, content, config, memory, longMemory, targetWatch, persist }) {
  if (!content.trim()) throw new Error('人格正文不能为空')
  if (config.activePersona === name && config.persona === content) return { ok: true, changed: false, persona: content }
  // 同名且正文一致（仅空白/换行差异）时只更新正文，不重置记忆：
  // 否则点一次「使用」就会把近期记忆和长期摘要全部清空。
  if (config.activePersona === name && String(config.persona || '').trim() === content.trim()) {
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
    const personaFile = (prefix, person) => path.join(config.dataDir, prefix + '__' + person + '.json')
    const readPersona = (file) => {
      try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null } catch { return null }
    }
    const from = config.activePersona
    if (from && from !== name) {
      try {
        if (recent) writeFileSync(personaFile('memory', from), JSON.stringify(recent))
        if (long) writeFileSync(personaFile('long-memory', from), JSON.stringify(long))
      } catch { /* 存不下就只保留备份，不阻断切换 */ }
    }
    const targetRecent = from && from !== name ? readPersona(personaFile('memory', name)) : null
    const targetLong = from && from !== name ? readPersona(personaFile('long-memory', name)) : null
    memory?.clear?.(); longMemory?.clear?.()
    if (targetRecent && targetRecent.chats) memory?.restore?.(targetRecent)
    if (targetLong && targetLong.chats) longMemory?.restore?.(targetLong)
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
