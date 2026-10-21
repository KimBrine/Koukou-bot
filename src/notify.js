import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** 异常通知：把重要事件发到管理员 QQ，同类事件做节流，避免刷屏。 */
export function createNotifier({ config, onebot, logger, file, now = () => Date.now() }) {
  let state = {}
  try { if (file && existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8')) || {} } catch { state = {} }
  const admin = String(config.adminUsers || '').split(',')[0].trim()
  const save = () => { try { if (file) writeFileSync(file, JSON.stringify(state)) } catch {} }
  async function notify(key, text, { minIntervalMs = 30 * 60 * 1000 } = {}) {
    if (!admin || !onebot) return false
    const last = Number(state[key] || 0)
    if (now() - last < minIntervalMs) return false
    state[key] = now(); save()
    try {
      await onebot.sendPrivate(admin, '[提醒] ' + text)
      logger?.warn?.('[通知] ' + text)
      return true
    } catch (err) {
      logger?.warn?.('[通知] 发送失败：' + err.message)
      return false
    }
  }
  return { notify, admin }
}
