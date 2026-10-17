import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** 只读取当前实例的私有资料；缺失时没有预置专属风格，不从示例目录自动导入。 */
export function readLocalProfile(dataDir) {
  const file = path.join(dataDir, 'profile.local.json')
  if (!existsSync(file)) return {}
  const bytes = readFileSync(file)
  if (bytes.length > 128 * 1024) throw new Error('私有风格配置过大')
  const value = JSON.parse(bytes.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('私有风格配置必须为对象')
  const out = {}
  if (typeof value.idCheckReminder === 'string') out.idCheckReminder = value.idCheckReminder.slice(0, 1600)
  if (typeof value.conversationRules === 'string' && value.conversationRules.length <= 20000) out.conversationRules = value.conversationRules
  if (Array.isArray(value.imageFallbackReplies)) out.imageFallbackReplies = value.imageFallbackReplies
    .filter(s => typeof s === 'string' && s.trim() && s.length <= 200).slice(0, 50)
  const decoration = value.decoration
  if (decoration && typeof decoration === 'object' && typeof decoration.symbol === 'string' && decoration.symbol.length <= 16) {
    out.decoration = { symbol: decoration.symbol,
      kaomoji: Array.isArray(decoration.kaomoji) ? decoration.kaomoji.filter(s => typeof s === 'string' && s.length <= 50).slice(0, 30) : [],
      voiceHint: typeof decoration.voiceHint === 'string' ? decoration.voiceHint.slice(0, 200) : '',
      weights: Object.fromEntries(['emoji', 'kaomoji', 'both'].map(k => [k, Math.max(0, Math.min(1, Number(decoration.weights?.[k]) || 0))])),
    }
  }
  return out
}
