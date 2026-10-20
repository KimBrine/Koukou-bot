import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './stateFile.js'

/**
 * 多个自定义识图接口，存放在实例数据目录，不随仓库发布。
 * 条目：{ id, name, baseUrl, apiKey, model }
 * 控制台只拿到打码后的 Key；更新时 Key 留空表示保持不变。
 */
export function createVisionProviders({ file, logger, legacy } = {}) {
  let items = []
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(parsed)) items = parsed.filter((x) => x && x.id && x.baseUrl)
    }
  } catch (err) {
    logger?.warn?.(`自定义识图配置读取失败：${err.message}`)
  }
  const save = () => { try { writeJsonAtomic(file, items) } catch (err) { logger?.warn?.(`自定义识图保存失败：${err.message}`) } }

  // 把旧的单个自定义配置迁移成一条记录
  if (items.length === 0 && legacy?.baseUrl && legacy?.apiKey) {
    items.push({ id: 'vp_' + randomUUID().slice(0, 6), name: '默认自定义', baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, model: legacy.model || '' })
    save()
    logger?.info?.('已把旧的自定义识图配置迁移为多条目')
  }

  const mask = (key) => (key ? '••••' + String(key).slice(-4) : '')
  const normalizeUrl = (v) => String(v || '').trim().replace(/\/+$/, '')

  function list() {
    return items.map((x) => ({ id: x.id, name: x.name || '未命名', baseUrl: x.baseUrl, model: x.model || '', hasKey: Boolean(x.apiKey), keyHint: mask(x.apiKey) }))
  }
  function get(id) { return items.find((x) => x.id === id) || null }
  function add({ name, baseUrl, apiKey, model } = {}) {
    const url = normalizeUrl(baseUrl)
    if (!/^https?:\/\//i.test(url)) throw new Error('接口地址要以 http:// 或 https:// 开头')
    if (!String(apiKey || '').trim()) throw new Error('请填写 API Key')
    const item = { id: 'vp_' + randomUUID().slice(0, 6), name: String(name || '').trim().slice(0, 30) || '自定义识图', baseUrl: url, apiKey: String(apiKey).trim(), model: String(model || '').trim() }
    items.push(item); save()
    return list().find((x) => x.id === item.id)
  }
  function update(id, { name, baseUrl, apiKey, model } = {}) {
    const item = get(id)
    if (!item) throw new Error('找不到这个自定义接口')
    if (baseUrl !== undefined) {
      const url = normalizeUrl(baseUrl)
      if (!/^https?:\/\//i.test(url)) throw new Error('接口地址要以 http:// 或 https:// 开头')
      item.baseUrl = url
    }
    if (name !== undefined) item.name = String(name).trim().slice(0, 30) || item.name
    if (model !== undefined) item.model = String(model).trim()
    const key = String(apiKey || '').trim()
    if (key) item.apiKey = key
    save()
    return list().find((x) => x.id === id)
  }
  function remove(id) {
    const i = items.findIndex((x) => x.id === id)
    if (i < 0) return false
    items.splice(i, 1); save(); return true
  }

  return { list, get, add, update, remove, count: () => items.length }
}
