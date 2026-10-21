import { accessSync, constants, existsSync, readFileSync, statfsSync } from 'node:fs'
import path from 'node:path'

const GB = 1024 * 1024 * 1024

/** 自检：把"能不能正常跑"拆成可读条目，控制台直接展示。 */
export function createSelfCheck({ config, onebot, backup, logger }) {
  return function run(status = null) {
    const items = []
    const add = (id, label, ok, detail = '', level = 'error') => items.push({ id, label, ok: Boolean(ok), detail, level: ok ? 'ok' : level })

    add('deepseek', 'DeepSeek Key', Boolean(config.deepseekApiKey), config.deepseekApiKey ? '已配置' : '未配置，聊天不可用')

    const st = status || (onebot && typeof onebot.status === 'function' ? onebot.status() : null)
    add('onebot', 'OneBot 连接', Boolean(st && st.connected), st && st.connected ? '已连接' : '未连接，检查 LLBot 与 3001 端口')
    add('qq', 'QQ 在线', Boolean(st && st.online), st && st.online ? '在线' : '离线或状态未知', 'warn')

    let writable = false
    try { accessSync(config.dataDir, constants.W_OK); writable = true } catch {}
    add('data', 'data 目录可写', writable, writable ? config.dataDir : '不可写，记忆与表情包无法保存')

    try {
      const stats = statfsSync(config.dataDir)
      const gb = (stats.bavail * stats.bsize) / GB
      add('disk', '磁盘剩余空间', gb > 1, gb.toFixed(1) + ' GB', 'warn')
    } catch { /* 老系统不支持就算了 */ }

    if (backup) {
      const last = backup.lastBackupAt()
      const hours = last ? (Date.now() - last) / 3600000 : 999
      add('backup', '最近备份', hours < 48, last ? Math.round(hours) + ' 小时前' : '还没有备份', 'warn')
    }

    for (const file of ['memory.json', 'chat-settings.json']) {
      const p = path.join(config.dataDir, file)
      let ok = true
      let detail = '正常'
      try { if (existsSync(p)) JSON.parse(readFileSync(p, 'utf8')) } catch { ok = false; detail = '文件损坏，无法解析' }
      add('file:' + file, file, ok, detail)
    }

    const failed = items.filter((x) => !x.ok).length
    return { at: Date.now(), failed, items }
  }
}
