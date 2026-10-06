import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { DeepSeekClient } from '../src/deepseek.js'
import { OneBotClient } from '../src/onebot.js'
import { parseMessage } from '../src/cq.js'
import { createLongMemory } from '../src/longMemory.js'

const config = loadConfig()
const logger = createLogger('info', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })

const useQwen = config.summaryProvider === 'dashscope'
const llm = new DeepSeekClient({
  apiKey: useQwen ? config.dashscopeApiKey : config.deepseekApiKey,
  baseUrl: useQwen ? config.dashscopeBaseUrl : config.deepseekBaseUrl,
  model: config.summaryModel || config.deepseekModel,
  temperature: 0.6,
  maxTokens: 2500,
  timeoutMs: 180000,
  maxRetries: 1,
  maxConcurrency: 1,
  logger,
  label: '记忆整理',
})

const longMemory = createLongMemory({
  file: path.join(config.dataDir, 'long-memory.json'),
  logger,
  llm: { chat: (p, m) => llm.chat(p, m) },
  maxChars: config.longMemoryMaxChars,
})

/** 读本地按天落盘的消息 */
function readLocal(groupId) {
  const dir = path.join(config.dataDir, 'daily', String(groupId))
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    for (const line of readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        out.push({ id: String(r.id), time: Number(r.time) || 0, name: r.name || '', text: String(r.text || '') })
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  return out
}

/** 读 NapCat 历史（单次上限约 960 条） */
async function readRemote(groupId) {
  try {
    const res = await onebot.getGroupMsgHistory(groupId, null, 30000, 1000)
    return (res?.messages || []).map((m) => {
      const parsed = parseMessage(m.message ?? m.raw_message, null)
      return {
        id: String(m.message_id),
        time: Number(m.time) || 0,
        name: m.sender?.card || m.sender?.nickname || String(m.user_id),
        text: parsed.text || '',
      }
    })
  } catch (err) {
    logger.warn(`群 ${groupId} 历史拉取失败：${err.message}`)
    return []
  }
}

onebot.on('ready', async () => {
  const groups = config.summaryGroups.length > 0 ? config.summaryGroups : [...config.whitelistGroups]
  console.log(`== 开始为 ${groups.length} 个群灌入历史记忆 ==\n`)
  for (const gid of groups) {
    const remote = await readRemote(gid)
    const local = readLocal(gid)
    // 合并去重（本地优先，含机器人自身视角的完整文本）
    const byId = new Map()
    for (const m of remote) byId.set(m.id, m)
    for (const m of local) byId.set(m.id, m)
    const all = [...byId.values()].filter((m) => m.text && m.text.trim()).sort((a, b) => a.time - b.time)
    if (all.length === 0) {
      console.log(`群 ${gid}：没有可用消息，跳过\n`)
      continue
    }
    const t0 = Date.now()
    console.log(`群 ${gid}：API ${remote.length} 条 + 本地 ${local.length} 条 → 去重后 ${all.length} 条，开始压缩…`)
    const ok = await longMemory.feed(`g${gid}`, all, { batchSize: 250 })
    const summary = longMemory.get(`g${gid}`)
    console.log(`群 ${gid}：${ok ? '✅ 完成' : '⚠️ 部分失败'}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，长期记忆 ${summary.length} 字`)
    console.log(`摘要预览：${summary.slice(0, 200)}…\n`)
  }
  longMemory.save()
  console.log('== 全部完成，长期记忆已保存 ==')
  onebot.stop()
  process.exit(0)
})

onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => {
  console.error('全局超时')
  process.exit(2)
}, 900000)
