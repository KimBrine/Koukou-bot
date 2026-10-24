import { isQuietHour } from './humanize.js'

// null/undefined 继承全局，空字符串是明确的会话覆盖。每次发送前读取当前设置。
export function quietBlocked(config, chatSettings, key, now = new Date()) {
  if (config.quietHoursBlockAll === false) return false
  return isQuietHour(chatSettings?.get?.(key)?.quietHours ?? config.quietHours, now)
}

// 仅用于互动处理器的传输视图，不修改共享 OneBot，也不拦截边界早晚安。
// 防止下载、识图、打包等异步操作跨过入睡时间后仍向 QQ 提交动作。
export function quietTransport(onebot, blocked) {
  const group = new Set(['sendGroup', 'sendGroupForward', 'repeatGroupMessage', 'setGroupBan', 'clearGroupBan', 'setGroupWholeBan', 'setGroupKick', 'pokeGroupMember'])
  const privateMethods = new Set(['sendPrivate', 'sendPrivateForward'])
  return new Proxy(onebot, {
    get(target, name) {
      const value = Reflect.get(target, name, target)
      if (typeof value !== 'function') return value
      return (...args) => {
        let key
        if (group.has(name)) key = `g${args[0]}`
        else if (privateMethods.has(name)) key = `p${args[0]}`
        else if (name === 'poke') key = args[0]?.groupId ? `g${args[0].groupId}` : `p${args[0]?.userId}`
        else if (name === 'api' && /^(?:send_|upload_|set_group_|group_poke$|friend_poke$)/.test(String(args[0]))) {
          const params = args[1] || {}
          key = params.group_id ? `g${params.group_id}` : params.user_id ? `p${params.user_id}` : null
        }
        if (key && blocked(key)) return Promise.reject(Object.assign(new Error('寂静时段，取消本次互动，不补发'), { code: 'QUIET_HOURS_BLOCKED' }))
        return Reflect.apply(value, target, args)
      }
    },
  })
}
