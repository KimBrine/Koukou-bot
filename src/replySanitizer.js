import { stripDecoration } from './humanize.js'

// 只清理程序自有的标记，不影响普通【通知】、QQ 表情或 CQ 消息段。
const labels = '此前回复对象|对话关系备注|登录补读[；;]\\s*历史消息|历史消息|角色已确认|角色身份未确认'
const internalStart = new RegExp(`([【\\[])\\s*(?:${labels})(?=[：:\\s】\\]\\r\\n]|$)`, 'gu')

export function stripInternalReplyMetadata(raw) {
  const original = String(raw ?? '')
  // 模型偶尔会把工具调用残留（<tool_result>…）当正文吐出来，直接清掉
  const cleaned = original
    .replace(/<tool_result[\s\S]*?(?:<\/tool_result>|$)/gi, '')
    .replace(/<tool_calls[\s\S]*?(?:<\/tool_calls>|$)/gi, '')
    .replace(/<\/?(?:tool_result|tool_calls?|function_call)[^>]*>/gi, '')
  let text = cleaned.replace(/\r\n?/g, '\n')
  let removed = false
  // 缺右括号的残片按本行丢弃；引号内的括号属于昵称，不提前结束元数据。
  for (;;) {
    internalStart.lastIndex = 0
    const match = internalStart.exec(text)
    if (!match) break
    removed = true
    const close = match[1] === '【' ? '】' : ']'
    let at = match.index + match[0].length, end = text.length, quote = '', escaped = false
    for (; at < text.length; at++) {
      const c = text[at]
      if (c === '\n') { end = at; break }
      if (quote) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === quote) quote = ''
      } else if (c === '"' || c === "'" || c === '“' || c === '‘') quote = c === '“' ? '”' : c === '‘' ? '’' : c
      else if (c === close) { end = at + 1; break }
    }
    text = text.slice(0, match.index) + text.slice(end)
  }
  const unbracketed = text.replace(/^[ \t]*(?:此前回复对象|对话关系备注)[：:][^\n]*/gm, '')
  removed ||= unbracketed !== text
  text = unbracketed.trim()
  // 被格式器附在标记后面的装饰不算正文，交给调用方重生成。
  if (removed && !stripDecoration(text).replace(/[\s，。！？、：:;；"'“”‘’…～~]/g, '')) return ''
  return text
}

export const REPLY_REPAIR_HINT = '\n\n【重新回答】上一份输出没有可发送的聊天正文。现在只输出对当前消息的自然回答，不要输出任何时间、回复对象、角色确认或其他内部阅读备注；不要讨论本条要求。'
