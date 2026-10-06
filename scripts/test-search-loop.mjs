import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { DeepSeekClient } from '../src/deepseek.js'
import { createWebSearch } from '../src/search.js'

const config = loadConfig()
const logger = createLogger('info', null)
const llm = new DeepSeekClient({
  apiKey: config.deepseekApiKey,
  baseUrl: config.deepseekBaseUrl,
  model: config.deepseekModel,
  temperature: 1.1,
  maxTokens: 400,
  timeoutMs: 60000,
  maxRetries: 1,
  maxConcurrency: 1,
  logger,
  label: 'DeepSeek',
})
const webSearch = createWebSearch({ apiKey: config.baiduApiKey, timeoutMs: 20000, logger })

const TOOLS = [{
  type: 'function',
  function: {
    name: 'web_search',
    description: '当需要最新信息时使用',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}]

const msgs = [
  { role: 'system', content: '你是一个可爱的群友，用口语回答。需要最新信息时调用 web_search 工具。' },
  { role: 'user', content: '今天北京天气怎么样？' },
]
const first = await llm.chatRaw(msgs, TOOLS)
console.log('第一轮 content:', JSON.stringify(first.content).slice(0, 80))
console.log('第一轮 toolCalls:', JSON.stringify(first.toolCalls?.map((c) => c.function))?.slice(0, 200))
if (first.toolCalls?.length) {
  const call = first.toolCalls[0]
  const query = JSON.parse(call.function.arguments).query
  console.log('执行搜索:', query)
  const { summary } = await webSearch(query)
  console.log('搜索摘要长度:', summary.length)
  msgs.push({ role: 'assistant', content: first.content || '', tool_calls: first.toolCalls })
  msgs.push({ role: 'tool', tool_call_id: call.id, content: summary.slice(0, 2000) })
  const second = await llm.chatRaw(msgs)
  console.log('最终回复:', second.content.slice(0, 300))
}
