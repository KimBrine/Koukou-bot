import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createStickers } from './stickers.js'
import { writeJsonAtomic } from './stateFile.js'

/** Keep the legacy library with its first owner; all other personas start empty. */
export function createPersonaStickers({ dir, config, chatSettings, memory, logger }) {
  const keyOf = name => createHash('sha256').update(JSON.stringify(['persona', name])).digest('hex')
  const nameOf = chatKey => String((chatKey && chatSettings?.get(chatKey)?.persona) || config.activePersona || '').trim()
  const registryFile = path.join(dir, 'persona-libraries.json')
  let registry
  if (existsSync(registryFile)) {
    registry = JSON.parse(readFileSync(registryFile, 'utf8'))
    if (registry?.version !== 1 || typeof registry.legacyOwner !== 'string' || registry.legacyKey !== keyOf(registry.legacyOwner)) {
      throw new Error('人格表情包归属记录损坏，请恢复备份')
    }
  } else {
    const owner = nameOf()
    registry = { version: 1, legacyOwner: owner, legacyKey: keyOf(owner) }
    writeJsonAtomic(registryFile, registry)
  }
  const libraries = new Map()
  function scope(chatKey) {
    const name = nameOf(chatKey)
    return { key: keyOf(name), name: name || '默认人格', token: JSON.stringify([keyOf(name), config.personaRevision || 0, chatKey ? memory?.version?.(chatKey) : '']) }
  }
  function forChat(chatKey) {
    const { key } = scope(chatKey)
    if (!libraries.has(key)) libraries.set(key, createStickers({
      dir: key === registry.legacyKey ? dir : path.join(dir, 'personas', key), logger,
    }))
    return libraries.get(key)
  }
  function snapshot(chatKey) {
    const selected = scope(chatKey), revision = config.personaRevision, version = memory?.version?.(chatKey)
    return { ...selected, store: forChat(chatKey), current: () => scope(chatKey).key === selected.key &&
      config.personaRevision === revision && memory?.version?.(chatKey) === version }
  }
  // Existing console operations target the selected global persona. Runtime callers pin forChat/snapshot.
  return new Proxy({ scope, forChat, snapshot }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      const store = forChat(), value = store[prop]
      return typeof value === 'function' ? value.bind(store) : value
    },
  })
}
