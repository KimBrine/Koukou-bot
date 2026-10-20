import { setTimeout as delay } from 'node:timers/promises'
const sleep = async (ms, signal) => {
  try { await delay(ms, undefined, { signal }) }
  catch (error) { signal?.throwIfAborted(); throw error }
}

// 仅为支持混合思考的千问型号传入该扩展参数，避免影响其他服务商。
export const isQwenHybridModel = model => /^qwen(?:3(?:\.\d+)?-(?:flash|plus|vl-(?:flash|plus))|-(?:flash|plus))(?:$|-)/i.test(String(model))

/**
 * OpenAI 兼容的 Chat Completions 客户端（DeepSeek / 通义千问 DashScope 通用）。
 * - 内置并发信号量（MAX_CONCURRENCY），防止群聊刷屏时打爆限流；
 * - 网络错误 / 429 / 5xx 自动指数退避重试；401/402/400 直接报错；
 * - chatVision() 支持把图片（data URL）作为多模态内容发给视觉模型；
 * - chatRaw() 支持函数调用（tools），返回 content 与 tool_calls。
 */
export class DeepSeekClient {
  constructor({ apiKey, baseUrl, model, temperature, maxTokens, timeoutMs, maxRetries, maxConcurrency, logger, label = '模型接口', enableThinking, reasoningEffort }) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.model = model
    this.temperature = temperature
    this.maxTokens = maxTokens
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.logger = logger
    this.label = label
    this.enableThinking = enableThinking
    if (reasoningEffort !== undefined && !['none','low','high','max'].includes(reasoningEffort)) throw new Error('不支持的 DeepSeek 思考强度')
    this.reasoningEffort = reasoningEffort
    this.active = 0
    this.queue = []
    this.concurrencyLimit = maxConcurrency
  }

  async #acquire(signal) {
    signal?.throwIfAborted()
    if (this.active < this.concurrencyLimit) {
      this.active += 1
      return
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve, signal, aborted: null }
      entry.aborted = () => {
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal.reason)
      }
      this.queue.push(entry)
      signal?.addEventListener('abort', entry.aborted, { once: true })
    })
  }

  #release() {
    const next = this.queue.shift()
    if (next) {
      next.signal?.removeEventListener('abort', next.aborted)
      next.resolve() // 把已有位置直接交给等待者，避免新请求抢入后超过并发上限。
    } else this.active -= 1
  }

  /** 纯文本对话：messages 为 [{role, content}] 历史（不含 system） */
  async chat(systemPrompt, messages, { rejectTruncated = false, signal, maxTokens = this.maxTokens, temperature = this.temperature } = {}) {
    const configured=Number.isFinite(this.maxTokens)&&this.maxTokens>0?Math.floor(this.maxTokens):undefined
    const requested=Number.isFinite(maxTokens)&&maxTokens>0?Math.max(1,Math.floor(maxTokens)):undefined
    const outputBudget=configured===undefined?requested:requested===undefined?configured:Math.min(configured,requested)
    await this.#acquire(signal)
    try {
      let lastErr = null
      // 偶发空回复（模型把预算花在推理上、或响应被截断）在这里重试一次：
      // 不然这条消息就被静默丢掉了，群里看起来像"机器人没反应"。
      for (let attempt = 0; attempt < 2; attempt++) {
        const data = await this.#post({
          model: this.model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          temperature: Number.isFinite(temperature)?Math.max(0,Math.min(2,temperature)):this.temperature,
          max_tokens: outputBudget,
          stream: false,
        }, signal)
        const finishReason = data?.choices?.[0]?.finish_reason
        if (finishReason === 'content_filter') {
          const err = new Error(`${this.label} 内容检查未通过`)
          err.code = 'content_filter'
          throw err
        }
        if (rejectTruncated && finishReason === 'length') {
          const err = new Error(`${this.label} 达到输出 token 上限（max_tokens=${outputBudget??'服务商自身上限'}，completion_tokens=${data?.usage?.completion_tokens ?? '未知'}）`)
          err.code = 'OUTPUT_LIMIT'
          throw err
        }
        const content = data?.choices?.[0]?.message?.content
        if (typeof content === 'string' && content.trim() !== '') return content.trim()
        lastErr = new Error(`${this.label} 返回内容为空`)
        this.logger.warn(`[空回复诊断] finish=${finishReason ?? '-'} 输出token=${data?.usage?.completion_tokens ?? '-'} 推理token=${data?.usage?.completion_tokens_details?.reasoning_tokens ?? '-'} max_tokens=${outputBudget ?? '-'} 思考=${this.reasoningEffort ?? '未发送'}`)
        if (attempt === 0) {
          this.logger.warn(`${this.label} 返回内容为空，1 秒后按原思考强度重试一次`)
          await sleep(1000, signal)
        }
      }
      throw lastErr
    } finally {
      this.#release()
    }
  }

  /**
   * 多模态对话：history 为纯文本历史；最后一条用户消息由 textContent 和 imageParts 组成。
   * imageParts：[{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } }]
   */
  async chatVision(systemPrompt, history, textContent, imageParts) {
    const messages = [...history]
    const content = []
    if (textContent) content.push({ type: 'text', text: textContent })
    content.push(...imageParts)
    messages.push({ role: 'user', content })
    await this.#acquire()
    try {
      return await this.#request(messages)
    } finally {
      this.#release()
    }
  }

  /**
   * 只让视觉模型"读图"：给它一段任务提示词和图片，返回平实的描述文本。
   * 刻意**不带聊天历史、不给人设**——它就只干读图这一件事，写回复是文字模型的活
   * （原因见 src/visionNote.js：让它直接写回复时，它会对着聊天记录截图写出一整篇分析报告）。
   */
  async describeImages(systemPrompt, textContent, imageParts, { maxTokens = 400, temperature = 0.3, signal } = {}) {
    const content = []
    if (textContent) content.push({ type: 'text', text: textContent })
    content.push(...imageParts)
    await this.#acquire(signal)
    try {
      const data = await this.#post({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
        ],
        temperature,
        max_tokens: maxTokens===0?undefined:maxTokens,
        stream: false,
      }, signal)
      const out = data?.choices?.[0]?.message?.content
      return typeof out === 'string' ? out.trim() : ''
    } finally {
      this.#release()
    }
  }

  /** 带工具调用的原始对话：messages 完整（含 system），返回 { content, toolCalls } */
  async chatRaw(messages, tools = null) {
    await this.#acquire()
    try {
      const body = {
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false,
      }
      if (tools && tools.length > 0) body.tools = tools
      const data = await this.#post(body)
      const m = data?.choices?.[0]?.message || {}
      return {
        content: typeof m.content === 'string' ? m.content.trim() : '',
        toolCalls: Array.isArray(m.tool_calls) && m.tool_calls.length > 0 ? m.tool_calls : null,
      }
    } finally {
      this.#release()
    }
  }

  async #request(messages) {
    const data = await this.#post({
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: false,
    })
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error(`${this.label} 返回内容为空`)
    }
    return content.trim()
  }

  /** 带重试的底层请求，返回解析后的 JSON */
  async #post(body, signal, effortOverride) {
    if (typeof this.enableThinking === 'boolean') body = { ...body, enable_thinking: this.enableThinking }
    // DeepSeek 与千问参数不同；由调用方按服务商显式传入，不能混用。
    // effortOverride：undefined = 用实例默认；null = 本次不发送；字符串 = 本次指定
    const effort = effortOverride === undefined ? this.reasoningEffort : effortOverride
    if (effort !== undefined && effort !== null) body = { ...body,
      thinking: {type: effort === 'none' ? 'disabled' : 'enabled'},
      reasoning_effort: effort }
    let lastError = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      signal?.throwIfAborted()
      const controller = new AbortController()
      const timer = this.timeoutMs===0?null:setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        })
        if (!res.ok) {
          const rawDetail = await res.text().catch(() => '')
          const detail = rawDetail.slice(0, 300)
          const err = new Error(this.#friendlyHttpError(res.status, detail))
          err.status = res.status
          try { const data = JSON.parse(rawDetail); err.code = data?.error?.code || data?.error?.type || data?.code } catch { /* 非 JSON 错误保留原文 */ }
          throw err
        }
        // 超时覆盖响应正文读取；收到 HTTP 头不代表模型已经输出完毕。
        return await res.json()
      } catch (err) {
        clearTimeout(timer)
        // 单群总时限取消时终止请求与重试，不占住其他群的生成位置。
        signal?.throwIfAborted()
        // fetch 的 "fetch failed" 本身没有信息量，真正的原因在 err.cause 里（ECONNRESET / ETIMEDOUT / DNS…）
        const cause = err?.cause ? `（原因：${err.cause.code || err.cause.message || err.cause}）` : ''
        const msg = `${err?.message ?? err}${cause}`
        // AbortError 可能是 message 只读的 DOMException，不能原地覆盖。
        lastError = new Error(msg, { cause: err })
        lastError.name = err?.name || 'Error'
        if (err?.status !== undefined) lastError.status = err.status
        if (err?.code !== undefined) lastError.code = err.code
        const retryable =
          !err?.status ||
          err.status === 429 ||
          err.status >= 500 ||
          err?.name === 'AbortError' ||
          /fetch failed|network|ECONN|ETIMEDOUT|UND_ERR/i.test(msg)
        if (!retryable || attempt >= this.maxRetries) {
          break
        }
        const wait = Math.min(8000, 1000 * 2 ** attempt)
        this.logger.warn(`${this.label} 调用失败（第 ${attempt + 1}/${this.maxRetries + 1} 次）：${msg}，${wait / 1000}s 后重试`)
        await sleep(wait, signal)
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError || new Error(`${this.label} 调用失败`)
  }

  #friendlyHttpError(status, detail) {
    if (/DataInspectionFailed|data_inspection_failed|content_filter|content_policy_violation/i.test(detail)) return `${this.label} 内容检查未通过（HTTP ${status}）：${detail}`
    if (status === 401) return `${this.label} API Key 无效（HTTP 401）：${detail || '无详细信息'}`
    if (status === 402) return `${this.label} 账户余额不足（HTTP 402）`
    if (status === 429) return `${this.label} 请求过于频繁（HTTP 429），将自动重试`
    if (status === 400) return `${this.label} 请求参数错误（HTTP 400）：${detail || ''}`.trim()
    return `${this.label} 请求失败（HTTP ${status}）：${detail || '无详细信息'}`
  }
}
