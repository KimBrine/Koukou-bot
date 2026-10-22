/**
 * 群名片核对（/id_check）：群里的名字要写成「房间号＋名字」，否则 @ 他提醒改名。
 *
 * 格式规则（**宽松优先，宁可放过不可误伤**）：
 * - 房间号首位是楼层，**只允许 6~10 层** → 6xx / 7xx / 8xx / 9xx / 10xx
 *   （502 是 5 楼、1102 是 11 楼，都不合格）
 * - 房间号写在整个名字的**最前面**（「东d702李佳轩」不算，702 在中间）
 * - **房间号与名字之间不需要空格**：604方铁 = 604 方铁 = 604　方铁（全角空格也行）
 * - 名字可以是网名/小名/符号，**也可以完全为空**，只写「604」就算通过
 * - 全角数字「６０４」按半角处理（手机中文输入法很容易打出来）
 *
 *   ✓ 604方铁   ✓ 604 方铁   ✓ 906李扣扣   ✓ 1009   ✓ ６０４方铁   ✓ 707-吴钧皓
 *   ✗ 502王五   ✗ 1102赵六   ✗ 方铁        ✗ 6045名字（不是合法房间号）   ✗ 东d702李佳轩
 */

/** 房间号：6xx / 7xx / 8xx / 9xx / 10xx，且后面不能再跟数字（避免 6045 被当成 604） */
export const ROOM_RE = /^(?:[6-9]\d{1,2}|10\d{1,2})(?!\d)/

/** 全角数字 ０-９ 转半角 0-9（只影响核对，不改变群名片本身） */
export function toHalfWidthDigits(text) {
  return String(text ?? '').replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

/**
 * 触发"核对并踢人"指令。
 * 严格整句匹配：`/id_check /id_check_kick` 这种**一条消息里同时写两个指令的打法不匹配任何一个**，
 * 必须分两条消息发 —— 这样"看一眼名单"和"动手踢人"之间必然隔着一次人为确认。
 */
export const ID_CHECK_KICK_CMD_RE = /^[\/／]?\s*(?:id[_\s-]?check[_\s-]?kick|核对踢人|查名片踢人|名字核对踢人)\s*[。！!~～.…]*$/i

/** 核对结果的有效期：超过这个时间就不认了（用户要求 5 分钟） */
export const ID_CHECK_KICK_WINDOW_MS = 5 * 60 * 1000

/**
 * 判断现在能不能执行踢人。
 *
 * 用户给的前置条件（全部满足才动手，否则**静默什么都不做**）：
 *   1. 机器人自己在这个群有管理员权限（群主也行）
 *   2. 5 分钟内刚跑过一次 /id_check（且现在还没过期）
 *   3. 那次 /id_check 的结果**还没被用来踢过人**（一次核对只能踢一次）
 *   4. 发指令的人在 ID_CHECK_OPERATORS 指定的授权名单里
 *   5. 那次核对里有不合格的人（一个都没有就没什么可踢的）
 *
 * 纯函数：不碰网络、不碰状态，方便把每条前置条件都钉死测出来。
 *
 * @param {object} o
 * @param {{group_id?:number, at:number, bad:Array, kicked?:boolean}|null|undefined} o.record 上次核对结果
 * @param {number|string} o.groupId 当前群号
 * @param {number|string} o.userId 发指令的人
 * @param {Array} o.operators 授权名单
 * @param {number} o.now 当前时间戳
 * @param {boolean} o.isBotAdmin 机器人是否为管理员/群主
 * @param {number} [o.windowMs] 有效期
 * @returns {{ok:boolean, reason:string, list?:Array}}
 */
export function canKickNow({
  record,
  groupId,
  userId,
  operators = [],
  now = Date.now(),
  isBotAdmin = false,
  windowMs = ID_CHECK_KICK_WINDOW_MS,
}) {
  // 踢人是破坏性操作：授权名单为空时一律拒绝（fail-closed）。
  // /id_check 本身可以留开放默认，但"按结果批量移出成员"不能：默认配置下全群都能让机器人踢人。
  const allowed = (Array.isArray(operators) ? operators : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (allowed.length === 0) return { ok: false, reason: '未配置 ID_CHECK_OPERATORS，踢人已禁用' }
  if (!allowed.includes(String(userId ?? '').trim())) {
    return { ok: false, reason: `QQ ${userId} 不在授权名单里` }
  }
  if (!isBotAdmin) {
    return { ok: false, reason: '机器人不是管理员/群主，没有踢人权限' }
  }
  if (!record) {
    return { ok: false, reason: '还没有跑过 /id_check（或结果已被清理）' }
  }
  if (String(record.group_id ?? '') !== String(groupId ?? '')) {
    return { ok: false, reason: `上次核对的是别的群（${record.group_id}）` }
  }
  const age = now - Number(record.at ?? 0)
  if (!Number.isFinite(age) || age < 0 || age > windowMs) {
    return { ok: false, reason: `上次核对已过期（${Math.round(age / 1000)}s 前，上限 ${Math.round(windowMs / 1000)}s）` }
  }
  if (record.kicked) {
    return { ok: false, reason: '这次核对的结果已经用来踢过人了（一次核对只能踢一次）' }
  }
  const list = Array.isArray(record.bad) ? record.bad : []
  if (list.length === 0) {
    return { ok: false, reason: '上次核对没有不合格的人' }
  }
  return { ok: true, reason: `可以踢：${list.length} 人`, list }
}

/**
 * 触发指令：@机器人 发这些词就执行。
 * 容忍各种手输写法：/id_check、／idcheck、id check、/查名片、名字核对＋句末标点。
 */
export const ID_CHECK_CMD_RE = /^[\/／]?\s*(?:id[_\s-]?check|查名片|名片核对|名字核对)\s*[。！!~～.…]*$/i

/**
 * 谁能触发这个指令。防群员乱发指令 —— 只有在授权名单里的 QQ 才放行。
 * 名单为空时不限制（留个后门给自己调试用，正常都该配上）。
 */
export function canRunIdCheck(userId, operators = []) {
  const list = (Array.isArray(operators) ? operators : []).map((s) => String(s).trim()).filter(Boolean)
  if (list.length === 0) return true
  return list.includes(String(userId ?? '').trim())
}

/** 取用于核对的名字：群名片优先，其次昵称 */
export function displayName(member) {
  const card = String(member?.card ?? '').trim()
  if (card) return card
  return String(member?.nickname ?? '').trim()
}

/**
 * 从一串数字里推断楼层，只用于把原因说得具体点；判不准就返回 NaN，改用通用提示。
 * 宁可不说，也不能说错：6045 说成「楼层 60」、17 说成「楼层 1」都会让人更糊涂。
 */
function floorOf(num) {
  if (num.length === 3) return Number(num[0]) // 604 → 6 楼，502 → 5 楼
  if (num.length === 4 && num[0] === '1') return Number(num.slice(0, 2)) // 1102 → 11 楼
  // 其余（1~2 位、5 位以上、6045 这种）楼层判不准 → 交给通用提示
  return NaN
}

/**
 * 名字是否合格。
 * @returns {{ ok: boolean, reason?: string, room?: string }}
 */
export function checkName(rawName) {
  // 全角数字先转半角再判，避免「６０４方铁」被误伤
  const name = toHalfWidthDigits(String(rawName ?? '')).trim()
  if (!name) return { ok: false, reason: '没有群名片' }
  const m = ROOM_RE.exec(name)
  if (!m) {
    const num = /^(\d+)/.exec(name)?.[1]
    if (num) {
      const floor = floorOf(num)
      if (Number.isFinite(floor) && (floor < 6 || floor > 10)) {
        return { ok: false, reason: `楼层 ${floor} 不在 6~10 层范围内` }
      }
      return { ok: false, reason: '房间号格式不对（形如 604 或 1009）' }
    }
    return { ok: false, reason: '名字前面没有房间号' }
  }
  return { ok: true, room: m[0] }
}

/**
 * 服务账号的名字特征（**刻意收窄**，宁可漏判也不误伤真人）：
 * - QQ 系统账号：Q群管家 / 群助手 / 群机器人
 * - 带服务方括号标签：**【店员】**店员猫、【客服】、【官方】、【助手】
 * - 以「机器人 / 小助手」结尾
 * 真人给自己起名「【摸鱼】小明」不会被这里吃掉（标签必须是服务类词）。
 */
export const BOT_NAME_RE = /(群管家|群助手|群机器人|^【(?:店员|客服|官方|助手|系统|机器人)】|(?:机器人|小助手)$)/

/**
 * 像不像机器人账号。
 * 最可靠的是 NapCat 给的 is_robot 标志（Q群管家 = true）；
 * 第三方小号机器人（如【店员】店员猫）QQ 不标 is_robot，只能靠名字特征兜一层。
 */
export function isLikelyBot(member, { botNameRe = BOT_NAME_RE } = {}) {
  if (member?.is_robot === true) return true
  if (!botNameRe) return false
  return botNameRe.test(displayName(member))
}

/**
 * 核对整个群。
 * @param {Array} members get_group_member_list 的返回
 * @param {{ selfId?: string, skip?: string[], skipBots?: boolean, botNameRe?: RegExp }} opts
 *   selfId 机器人自己；skip 额外跳过的账号；skipBots 是否跳过机器人/服务账号
 * @returns {{ total:number, ok:Array, bad:Array<{userId,name,reason,role}>,
 *             skipped:Array<{userId,name,why}> }}
 */
export function checkMembers(members, { selfId = '', skip = [], skipBots = true, botNameRe } = {}) {
  const self = String(selfId ?? '')
  const skipSet = new Set(skip.map(String).filter(Boolean))
  const ok = []
  const bad = []
  const skipped = []
  for (const m of Array.isArray(members) ? members : []) {
    const userId = String(m?.user_id ?? '')
    if (!userId) continue
    const name = displayName(m)
    if (self && userId === self) {
      skipped.push({ userId, name, why: '机器人自己' })
      continue
    }
    if (skipSet.has(userId)) {
      skipped.push({ userId, name, why: 'ID_CHECK_SKIP 指定跳过' })
      continue
    }
    if (skipBots && isLikelyBot(m, { botNameRe })) {
      skipped.push({ userId, name, why: m?.is_robot === true ? 'QQ 机器人账号' : '名字像服务账号' })
      continue
    }
    const res = checkName(name)
    if (res.ok) ok.push({ userId, name, room: res.room })
    else bad.push({ userId, name, reason: res.reason, role: m?.role ?? 'member' })
  }
  return { total: ok.length + bad.length, ok, bad, skipped }
}

/**
 * 把"需要改名的人"拼成要发送的消息段。
 * 每个人一行：@他（QQ 会把 @ 渲染成他的群名片，正好就是「604 方铁」的样子），
 * 最后一行是提醒语。
 *
 * perMessage 默认 **0 = 不拆分**：所有人一次性 @ 在同一条消息里（用户明确要求）。
 * 传正数才会按这个人数拆成多条，最后一条才带提醒语。
 */
export function buildReminderMessages(bad, { reminder = '以上群友记得改名哦~', perMessage = 0 } = {}) {
  const list = Array.isArray(bad) ? bad : []
  if (list.length === 0) return []
  const segmentsFor = (chunk, withReminder) => {
    const segments = []
    for (const person of chunk) {
      segments.push({ type: 'at', data: { qq: person.userId } })
      segments.push({ type: 'text', data: { text: '\n' } })
    }
    if (withReminder) segments.push({ type: 'text', data: { text: reminder } })
    return segments
  }
  const size = Math.floor(Number(perMessage)) || 0
  if (size <= 0) return [segmentsFor(list, true)]
  const messages = []
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size)
    messages.push(segmentsFor(chunk, i + size >= list.length))
  }
  return messages
}

/** 给日志/控制台看的一行摘要 */
export function summarize(bad, { max = 12 } = {}) {
  if (bad.length === 0) return '全部合格'
  const head = bad
    .slice(0, max)
    .map((b) => `${b.name || '(空)'}(${b.userId}) ${b.reason}`)
    .join('；')
  return bad.length > max ? `${head}；…共 ${bad.length} 人` : head
}
