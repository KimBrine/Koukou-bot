import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './stateFile.js'

export function sessionPersona(config, name) {
  const selected = String(name || '').trim()
  if (!selected) return { name: '', text: '', digest: '' }
  if (selected.length > 60 || /[\\/:*?"<>|\u0000-\u001f]/.test(selected) || /[. ]$/.test(selected)) throw new Error('本会话人格名称无效')
  const file = path.join(config.personaDir || path.join(config.dataDir, 'personas'), selected + '.txt')
  if (!existsSync(file)) throw new Error('本会话人格文件不存在，请重新选择')
  const text = readFileSync(file, 'utf8').trim()
  if (!text || text.length > 262144) throw new Error('本会话人格正文为空或过大')
  return { name: selected, text, digest: createHash('sha256').update(text).digest('hex') }
}

/** 清理即建立新边界；备份保留原文分区引用，旧资料只可手动恢复。 */
export function resetConversationMemory({ config, memory, longMemory, targetWatch, key = null, reason = '清理记忆', persist = () => {} }) {
  if (key !== null && !/^[gp]\d{1,24}$/.test(key)) throw new Error('会话标识无效')
  const recent = memory?.snapshot?.(), long = longMemory?.snapshot?.()
  const keys = key ? [key] : [...new Set([...Object.keys(recent?.chats || {}), ...Object.keys(long?.chats || {})])]
  const counts = {
    sessions: keys.length,
    recent: keys.reduce((n, k) => n + (recent?.chats?.[k]?.length || 0), 0),
    longTerm: keys.filter(k => long?.chats?.[k]).length,
  }
  if (recent || long) writeJsonAtomic(path.join(config.dataDir, 'config-backups', `memory-reset-${Date.now()}-${randomUUID()}.json`), { at: Date.now(), reason, key, recent, long })
  try {
    if (key) { memory?.clearKey?.(key); longMemory?.clearKey?.(key) }
    else { memory?.clear?.(); longMemory?.clear?.() }
    persist()
  } catch (err) {
    const errors = []
    for (const [service, snapshot] of [[memory, recent], [longMemory, long]]) {
      if (snapshot) try { service.restore(snapshot) } catch (restoreError) { errors.push(restoreError.message) }
    }
    throw new Error(`记忆操作失败：${err.message}${errors.length ? '；恢复失败，请检查私有备份' : '；已保留原记忆'}`)
  }
  if (!key || key === `g${config.targetWatchGroup}`) targetWatch?.resetPending?.()
  return { ...counts, backedUp: Boolean(recent || long) }
}

export function applyConversationSettings(options) {
  const { key, patch, chatSettings, config } = options
  if (!/^[gp]\d{1,24}$/.test(key)) throw new Error('会话标识无效')
  if (!Object.hasOwn(patch, 'persona')) return { settings: chatSettings.set(key, patch), reset: null }
  const chosen = sessionPersona(config, patch.persona)
  const previous = chatSettings.get(key)
  const next = { ...patch, persona: chosen.name, personaDigest: chosen.digest }
  if ((previous.persona || '') === chosen.name && (previous.personaDigest || '') === chosen.digest)
    return { settings: chatSettings.set(key, next), reset: null }
  const reset = resetConversationMemory({ ...options, reason: '切换本会话人格', persist: () => chatSettings.set(key, next) })
  return { settings: chatSettings.get(key), reset }
}

// 私有人格文件被编辑后，下一轮也建立新边界，不把旧人格助手样例带给新正文。
export function prepareSessionPersona(options) {
  const { key, chatSettings, config } = options
  const selected = chatSettings?.get?.(key)?.persona || ''
  if (!selected) return ''
  const chosen = sessionPersona(config, selected)
  if (chatSettings.get(key).personaDigest !== chosen.digest) applyConversationSettings({ ...options, patch: { persona: selected } })
  return chosen.text
}

export function sameSessionPersona(config, chatSettings, key, text) {
  try { return sessionPersona(config, chatSettings?.get?.(key)?.persona || '').text === text }
  catch { return false }
}
