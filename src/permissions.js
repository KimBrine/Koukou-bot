/**
 * 管理员（最高权限）判定。
 *
 * ADMIN_USERS 留空时，群总结等沿用旧的公开范围；
 * 清理记忆等破坏性操作需调用方另行要求 hasAdmins()，不可仅依赖 isBotAdmin()。
 * ADMIN_USERS 有值 = 只有名单里的 QQ 能用特权指令，其他人收到一句礼貌拒绝。
 */

/** 解析/规整管理员名单：接受数组或逗号分隔字符串，去掉空白与空项 */
export function normalizeAdmins(list) {
  const raw = Array.isArray(list) ? list : String(list ?? '').split(',')
  return raw.map((s) => String(s ?? '').trim()).filter(Boolean)
}

/** 是否配置了管理员名单 */
export function hasAdmins(adminUsers) {
  return normalizeAdmins(adminUsers).length > 0
}

/** 该 QQ 是否有最高权限；名单为空时视为"不限制"（兼容旧行为） */
export function isBotAdmin(userId, adminUsers) {
  const list = normalizeAdmins(adminUsers)
  if (list.length === 0) return true
  return list.includes(String(userId ?? '').trim())
}

/**
 * 特权指令的管理员状态说明，用于回复与日志。
 * 区分三种情况，避免用户猜不出为什么指令没反应。
 */
export function adminHint(adminUsers) {
  const list = normalizeAdmins(adminUsers)
  if (list.length === 0) return '当前未配置管理员，群总结等沿用公开范围；QQ 清除记忆指令不可用'
  return `当前管理员 ${list.length} 人：${list.join('、')}`
}
