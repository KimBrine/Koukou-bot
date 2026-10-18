import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 按会话（群聊 / 私聊）的独立设置。
 *
 * 与 .env 的分工：
 * - .env 是全局默认值（所有会话共用的底子）；
 * - 这里只存"这个会话跟别人不一样"的部分，null / 空 表示"沿用全局"，
 *   所以以后改全局默认值，没单独设过的会话会跟着变，不会被早先的快照冻住。
 *
 * key 沿用记忆里的命名：群聊 `g<群号>`、私聊 `p<QQ号>`。
 */

const DEFAULTS = {
  enabled: true, // 总开关：关掉后这个会话完全不理
  atReplyEnabled: true, // 被 @ 或引用机器人消息时直接回复
  proactiveEnabled: true, // 允许主动搭话（仅在白名单群里才有意义）
  proactiveRate: null, // 覆盖全局主动搭话概率
  persona: '', // 本会话单独使用的人格名（空=跟随全局；只影响提示词，记忆仍按会话隔离）
  customPrompt: '', // 这个会话的客制化人设/要求，附加到系统提示词
  emojiKeepRate: null, // 覆盖装饰符号频率
  replyMaxLines: null, // 覆盖最多几行
  lineMaxChars: null, // 覆盖单行字数上限
  quietHours: null, // 覆盖安静时段（'' = 这个会话不设安静时段）
  note: '', // 备注名（界面上方便认人，不影响行为）
}

function normalizePatch(patch = {}) {
  const out = {}
  if ('enabled' in patch) out.enabled = patch.enabled !== false
  if ('atReplyEnabled' in patch) out.atReplyEnabled = patch.atReplyEnabled !== false
  if ('proactiveEnabled' in patch) out.proactiveEnabled = patch.proactiveEnabled !== false
  if ('proactiveRate' in patch) {
    const v = Number(patch.proactiveRate)
    out.proactiveRate = patch.proactiveRate === null || patch.proactiveRate === '' ? null : Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null
  }
  if ('persona' in patch) out.persona = String(patch.persona ?? '').trim().slice(0, 60)
  if ('customPrompt' in patch) out.customPrompt = String(patch.customPrompt ?? '').slice(0, 4000)
  if ('emojiKeepRate' in patch) {
    const v = Number(patch.emojiKeepRate)
    out.emojiKeepRate = patch.emojiKeepRate === null || patch.emojiKeepRate === '' ? null : Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null
  }
  if ('replyMaxLines' in patch) {
    const v = Number(patch.replyMaxLines)
    out.replyMaxLines = patch.replyMaxLines === null || patch.replyMaxLines === '' ? null : Number.isFinite(v) ? Math.max(1, Math.min(5, Math.floor(v))) : null
  }
  if ('lineMaxChars' in patch) {
    const v = Number(patch.lineMaxChars)
    out.lineMaxChars =
      patch.lineMaxChars === null || patch.lineMaxChars === '' ? null : Number.isFinite(v) ? Math.max(10, Math.min(200, Math.floor(v))) : null
  }
  if ('quietHours' in patch) {
    const s = String(patch.quietHours ?? '').trim()
    out.quietHours = s === '' ? '' : /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(s) ? s : null
  }
  if ('note' in patch) out.note = String(patch.note ?? '').slice(0, 60)
  return out
}

export function createChatSettings({ file, logger }) {
  const store = new Map()

  function load() {
    try {
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object') store.set(key, { ...normalizePatch(value) })
        }
      }
      logger?.info?.(`已载入 ${store.size} 个会话的独立设置`)
    } catch (err) {
      logger?.warn?.(`读取会话设置失败，将以默认设置运行：${err.message}`)
    }
  }

  function save() {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const obj = {}
      for (const [key, value] of store) obj[key] = value
      writeFileSync(file, JSON.stringify(obj, null, 2))
    } catch (err) {
      logger?.warn?.(`保存会话设置失败：${err.message}`)
    }
  }

  /** 取某个会话的设置（与默认值合并后的结果） */
  function get(key) {
    return { ...DEFAULTS, ...(store.get(key) ?? {}) }
  }

  /** 只取"被显式设置过"的原始值（界面上要显示"沿用全局"） */
  function raw(key) {
    return store.get(key) ?? null
  }

  function set(key, patch) {
    const next = { ...(store.get(key) ?? {}), ...normalizePatch(patch) }
    store.set(key, next)
    save()
    return get(key)
  }

  function remove(key) {
    store.delete(key)
    save()
  }

  function keys() {
    return [...store.keys()]
  }

  function all() {
    const out = {}
    for (const [key, value] of store) out[key] = { ...DEFAULTS, ...value }
    return out
  }

  /** 生效值解析：会话设置优先，其次全局 */
  function resolve(key, config) {
    const s = get(key)
    return {
      enabled: s.enabled,
      atReplyEnabled: s.atReplyEnabled,
      proactiveEnabled: s.proactiveEnabled,
      proactiveRate: s.proactiveRate ?? (config.proactiveRateFor ? config.proactiveRateFor(keyToGroupId(key)) : config.proactiveRate),
      customPrompt: s.customPrompt,
      persona: s.persona || '',
      emojiKeepRate: s.emojiKeepRate ?? config.emojiKeepRate,
      replyMaxLines: s.replyMaxLines ?? config.replyMaxLines,
      lineMaxChars: s.lineMaxChars ?? config.replyLineMaxChars,
      quietHours: s.quietHours === null ? config.quietHours : s.quietHours,
    }
  }

  load()
  return { get, raw, set, remove, keys, all, resolve, save, defaults: DEFAULTS }
}

/** `g200000019` → 200000019；`p200000007` → null（私聊没有群号） */
export function keyToGroupId(key) {
  const m = /^g(\d+)$/.exec(String(key ?? ''))
  return m ? Number(m[1]) : null
}

export function keyToUserId(key) {
  const m = /^p(\d+)$/.exec(String(key ?? ''))
  return m ? Number(m[1]) : null
}
