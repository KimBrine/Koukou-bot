import { loadConfig } from '../src/config.js'
import { buildSummaryPrompt } from '../src/dailySummary.js'
import { parseMessage } from '../src/cq.js'

const config = loadConfig()
const GROUP = Number(process.argv[2] || 200000018)
const MAXTOK = Number(process.argv[3] || 8000)

const ws = new WebSocket(config.onebotWsUrl)
let seq = 0
const pending = new Map()
function call(action, params, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const echo = String(++seq)
    const t = setTimeout(() => { pending.delete(echo); reject(new Error('timeout')) }, timeout)
    pending.set(echo, { resolve, reject, t })
    ws.send(JSON.stringify({ action, params, echo }))
  })
}
ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data)
  if (d.echo !== undefined && pending.has(d.echo)) {
    const p = pending.get(d.echo)
    pending.delete(d.echo)
    clearTimeout(p.t)
    d.status === 'ok' ? p.resolve(d.data) : p.reject(new Error(d.message || d.retcode))
  }
}

ws.onopen = async () => {
  try {
    const res = await call('get_group_msg_history', { group_id: GROUP, count: 600 })
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const startSec = Math.floor(midnight.getTime() / 1000)
    const lines = []
    for (const m of res.messages || []) {
      const t = Number(m.time) || 0
      if (t < startSec) continue
      const parsed = parseMessage(m.message ?? m.raw_message, null)
      const name = m.sender?.card || m.sender?.nickname || String(m.user_id)
      const hh = String(new Date(t * 1000).getHours()).padStart(2, '0')
      const mm = String(new Date(t * 1000).getMinutes()).padStart(2, '0')
      lines.push(`[${hh}:${mm}] ${name}：${String(parsed.text || '').slice(0, 120) || '（非文本消息）'}`)
    }
    lines.sort()
    const body = lines.join('\n')
    console.log(`群 ${GROUP} 今日消息 ${lines.length} 条，输入约 ${body.length} 字符`)
    const prompt = buildSummaryPrompt({ botName: config.botName, dateLabel: '2026-09-21', days: 1 })
    console.log(`尝试 max_tokens=${MAXTOK} …`)
    const t0 = Date.now()
    const r = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseekApiKey}` },
      body: JSON.stringify({
        model: config.summaryModel || config.deepseekModel,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: body }],
        temperature: 1.0,
        max_tokens: MAXTOK,
        stream: false,
      }),
    })
    const raw = await r.text()
    const d = JSON.parse(raw)
    const m = d.choices?.[0]?.message || {}
    console.log(`HTTP ${r.status}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log(`finish_reason: ${d.choices?.[0]?.finish_reason}`)
    console.log(`推理 token: ${d.usage?.completion_tokens_details?.reasoning_tokens ?? 0}`)
    console.log(`总 completion: ${d.usage?.completion_tokens}, prompt: ${d.usage?.prompt_tokens}`)
    console.log(`正文长度: ${m.content?.length ?? 0} 字`)
    console.log(`正文预览:\n${String(m.content || '(空)').slice(0, 300)}`)
    process.exit(0)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(1)
  }
}
setTimeout(() => { console.error('全局超时'); process.exit(2) }, 300000)
