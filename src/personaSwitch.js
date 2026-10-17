import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { writeJsonAtomic } from './stateFile.js'

// 人格目前全局生效，因此所有会话都必须建立新边界，不能只清理控制台选中的群。
export function activatePersona({ name, content, config, memory, longMemory, targetWatch, persist }) {
  if (!content.trim()) throw new Error('人格正文不能为空')
  if (config.activePersona === name && config.persona === content) return { ok: true, changed: false, persona: content }
  const recent = memory?.snapshot?.(), long = longMemory?.snapshot?.()
  const backup = (recent || long) ? path.join(config.dataDir, 'config-backups', `persona-switch-${Date.now()}-${randomUUID()}.json`) : null
  if (backup) writeJsonAtomic(backup, { time: Date.now(), from: config.activePersona || '', to: name, recent, long })
  try {
    memory?.clear?.(); longMemory?.clear?.()
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
