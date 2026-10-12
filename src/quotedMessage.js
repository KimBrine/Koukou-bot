const scope = evt => evt.message_type === 'private' ? `p${evt.user_id}` : `g${evt.group_id}`

/** 优先复用已收到的消息，查询失败时也能识别近期对机器人的引用。 */
export function createQuotedMessageResolver({ onebot, logger, maxEntries = 2000 }) {
  const messages = new Map()
  function remember(evt) {
    if (evt?.message_id == null || evt.message_id === '' || !evt.message_type) return
    const key = `${scope(evt)}:${String(evt.message_id)}`
    messages.delete(key)
    messages.set(key, evt)
    while (messages.size > maxEntries) messages.delete(messages.keys().next().value)
  }
  function rememberSent(evt, receipt, text) {
    if (receipt?.message_id == null) return
    remember({ ...evt, user_id: evt.message_type === 'private' ? evt.user_id : onebot.selfId,
      sender: { user_id: onebot.selfId }, message_id: receipt.message_id,
      message: [{ type: 'text', data: { text } }], authorId: onebot.selfId })
  }
  async function resolve(evt, id) {
    if (!id) return null
    const cached = messages.get(`${scope(evt)}:${String(id)}`)
    if (cached) return cached
    if (typeof onebot.getMsg !== 'function') return null
    try {
      const result = await onebot.getMsg(String(id), 8000)
      if (!result || (result.message_id != null && String(result.message_id) !== String(id))) return null
      if (evt.message_type === 'group' && (result.message_type === 'private' ||
          (result.group_id != null && String(result.group_id) !== String(evt.group_id)))) return null
      if (evt.message_type === 'private') {
        if (result.message_type === 'group' || result.group_id != null) return null
        const author = result.user_id ?? result.sender?.user_id
        const recipient = result.target_id ?? result.peer_id
        if (author != null && String(author) !== String(onebot.selfId) && String(author) !== String(evt.user_id)) return null
        if (author != null && String(author) === String(onebot.selfId) && recipient != null && String(recipient) !== String(evt.user_id)) return null
      }
      // get_msg 的某些版本没有会话信息；缺省时使用当前引用发生的会话。
      const message = { ...result, message_type: evt.message_type, group_id: evt.group_id,
        ...(evt.message_type === 'private' ? { authorId: result.user_id ?? result.sender?.user_id, user_id: evt.user_id } : {}) }
      remember({ ...message, message_id: id })
      return message
    } catch (error) {
      logger.warn(`引用消息读取失败：${error.message}`)
      return null
    }
  }
  function isFromBot(message) {
    const author = message?.authorId ?? message?.sender?.user_id ?? message?.user_id
    return Boolean(onebot.selfId && author != null && String(author) === String(onebot.selfId))
  }
  return { remember, rememberSent, resolve, isFromBot }
}
