import { loadConfig } from '../src/config.js'
import { buildSummaryPrompt } from '../src/dailySummary.js'
import { parseMessage } from '../src/cq.js'

const config = loadConfig()
const GROUP = Number(process.argv[2] || 794601094)

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

async function tryModel(label, baseUrl, apiKey, model, prompt, body, maxTokens) {
  try {
    const t0 = Date.now()
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: body }], temperature: 1.0, max_tokens: maxTokens, stream: false }),
    })
    const raw = await r.text()
    if (!r.ok) {
      console.log(`\n[${label}] HTTP ${r.status}: ${raw.slice(0, 200)}`)
      return
    }
    const d = JSON.parse(raw)
    const m = d.choices?.[0]?.message || {}
    console.log(`\n[${label}] HTTP 200 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log(`  finish=${d.choices?.[0]?.finish_reason} 推理token=${d.usage?.completion_tokens_details?.reasoning_tokens ?? 0} 总completion=${d.usage?.completion_tokens} prompt=${d.usage?.prompt_tokens}`)
    console.log(`  正文长度: ${m.content?.length ?? 0} 字`)
    console.log(`  预览: ${String(m.content || '(空)').slice(0, 150).replace(/\n/g, ' / ')}`)
  } catch (e) {
    console.log(`\n[${label}] ERR ${e.message}`)
  }
}

ws.onopen = async () => {
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
    const d = new Date(t * 1000)
    lines.push(`[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}] ${name}：${String(parsed.text || '').slice(0, 120) || '（非文本消息）'}`)
  }
  lines.sort()
  const body = lines.join('\n')
  const prompt = buildSummaryPrompt({ botName: config.botName, dateLabel: '2026-09-21', days: 1 })
  console.log(`群 ${GROUP} 今日 ${lines.length} 条消息，输入 ${body.length} 字符`)

  await tryModel('DeepSeek v4-pro', config.deepseekBaseUrl, config.deepseekApiKey, 'deepseek-v4-pro', prompt, body, 8000)
  await tryModel('通义千问 qwen3.7-flash', config.dashscopeBaseUrl, config.dashscopeApiKey, 'qwen3.7-flash', prompt, body, 8000)
  await tryModel('通义千问 qwen3.7-plus', config.dashscopeBaseUrl, config.dashscopeApiKey, 'qwen3.7-plus', prompt, body, 8000)
  process.exit(0)
}
setTimeout(() => { console.error('超时'); process.exit(2) }, 400000)
