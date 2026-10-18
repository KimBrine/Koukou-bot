/**
 * 管理员（最高权限）判定。
 *
 * ADMIN_USERS 留空 = 不限制（沿用旧行为，任何人触发特权指令都放行），
 *                 启动日志里会明确警告，避免"以为设了其实没设"。
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
  if (list.length === 0) return '当前未配置管理员，任何人都能触发特权指令'
  return `当前管理员 ${list.length} 人：${list.join('、')}`
}
