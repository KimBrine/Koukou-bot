/**
 * 模型供应商目录与自动检测。
 * - 列表只用于界面预填，真正生效的是 .env 里的 baseUrl / model / apiKey；
 * - 检测走 OpenAI 兼容的 GET {baseUrl}/models（DeepSeek、DashScope 兼容模式、OpenAI、Kimi、GLM 都支持）；
 * - 检测失败给出可读原因，不抛未捕获异常到界面。
 */

export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyHint: 'sk-…' },
  { id: 'dashscope', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyHint: 'sk-…' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyHint: 'sk-…' },
  { id: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', keyHint: 'sk-…' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyHint: '…' },
  { id: 'custom', name: '自定义（任意 OpenAI 兼容接口）', baseUrl: '', keyHint: '按服务商要求填写' },
]

/** 思考强度：空字符串表示不发送参数，交给服务商默认行为 */
export const REASONING_LEVELS = [
  { id: '', name: '默认（不发送思考参数）' },
  { id: 'none', name: '关闭思考（DeepSeek）' },
  { id: 'low', name: '低（少量思考）' },
  { id: 'high', name: '高（思考更多）' },
  { id: 'max', name: '最高（最慢最贵）' },
]

export function normalizeProvider(id) {
  const key = String(id || '').trim().toLowerCase()
  return PROVIDERS.find((p) => p.id === key) || PROVIDERS.find((p) => p.id === 'custom')
}

export function normalizeReasoning(level) {
  const key = String(level || '').trim().toLowerCase()
  return REASONING_LEVELS.some((l) => l.id === key) ? key : ''
}

/** 请求体里要附加的思考参数；none = 显式关闭，其余为开启 */
export function reasoningPayload(level) {
  const normalized = normalizeReasoning(level)
  if (!normalized) return {}
  return { reasoning_effort: normalized, thinking: { type: normalized === 'none' ? 'disabled' : 'enabled' } }
}

function friendlyStatus(status) {
  if (status === 401 || status === 403) return '密钥无效或没有权限（401/403）'
  if (status === 404) return '接口地址不对，或该服务商没有 /models 接口（404）'
  if (status === 429) return '请求太频繁或额度不足（429）'
  if (status >= 500) return `服务商暂时不可用（${status}）`
  return `服务商返回 HTTP ${status}`
}

/**
 * 自动检测服务商可用模型。
 * 兼容两种常见返回：{ data: [{id}] }（OpenAI 风格）与 { models: [{name}] }（部分本地服务）。
 */
export async function detectModels({ baseUrl, apiKey, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('请先填写接口地址（Base URL）')
  if (!/^https?:\/\//i.test(base)) throw new Error('接口地址要以 http:// 或 https:// 开头')

  const url = base + '/models'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(2000, Number(timeoutMs) || 20000))
  let res
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (err?.name === 'AbortError') throw new Error(`检测超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或接口地址`)
    throw new Error(`连不上 ${url}：${err?.message || err}`)
  }
  clearTimeout(timer)

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const short = detail.replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(friendlyStatus(res.status) + (short ? `：${short}` : ''))
  }

  const data = await res.json().catch(() => null)
  const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
  const models = raw
    .map((m) => ({ id: String(m?.id || m?.name || m?.model || '').trim(), ownedBy: String(m?.owned_by || m?.ownedBy || '') }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (models.length === 0) throw new Error('接口有响应，但没有返回任何模型；可能该地址不是 OpenAI 兼容接口')
  return { ok: true, url, count: models.length, models }
}
