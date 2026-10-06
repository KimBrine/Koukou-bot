/**
 * 实例验收探针：确认"这一套 OneBot 背后到底是哪个 QQ，它在哪些群、是不是管理员"。
 * 迁移新号 / 切换后验收用。
 *
 *   node scripts/verify-instance.mjs [ws://127.0.0.1:3002]
 *
 * 默认读 .env 里的 ONEBOT_WS_URL；也可以直接传 URL，或用环境变量覆盖：
 *   $env:ONEBOT_WS_URL='ws://127.0.0.1:3002'; node scripts/verify-instance.mjs
 *
 * **只读，不发任何消息。**
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'

const url = process.argv[2] || process.env.ONEBOT_WS_URL || loadConfig().onebotWsUrl
const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url, logger })

const ROLE_CN = { owner: '群主', admin: '管理员', member: '普通成员' }

onebot.on('ready', async () => {
  try {
    console.log(`连接的 OneBot：${url}`)
    console.log(`机器人 QQ：${onebot.selfId}  昵称：${onebot.nickname}\n`)

    const groups = await onebot.getGroupList().catch((e) => {
      console.log(`拉群列表失败：${e.message}`)
      return []
    })
    const list = Array.isArray(groups) ? groups : (groups?.data ?? [])
    console.log(`=== 所在群：${list.length} 个 ===`)
    let adminCount = 0
    for (const g of list) {
      const gid = g.group_id ?? g.groupId
      let role = '未知'
      try {
        const me = await onebot.getGroupMemberInfo(gid, onebot.selfId)
        role = String(me?.role ?? 'member')
      } catch {
        /* 取不到就标未知 */
      }
      if (role === 'admin' || role === 'owner') adminCount++
      const flag = role === 'admin' || role === 'owner' ? '✅' : '  '
      console.log(`  ${flag} ${gid}  ${g.group_name ?? ''}  (${g.member_count ?? '?'} 人)  角色: ${ROLE_CN[role] ?? role}`)
    }

    console.log(`\n=== 关键结论 ===`)
    console.log(`  登录账号        : ${onebot.selfId}`)
    console.log(`  群数量          : ${list.length}`)
    console.log(`  有管理权限的群  : ${adminCount} 个  ${adminCount > 0 ? '（可以执行 /id_check_kick）' : '（❌ 无法执行 /id_check_kick，需要群主给管理员）'}`)

    // 和白名单/核对群配置对一下，看还缺哪些群
    const wanted = new Set([...(config.whitelistGroups ?? []), ...(config.idCheckGroups ?? [])])
    const have = new Set(list.map((g) => Number(g.group_id ?? g.groupId)))
    const missing = [...wanted].filter((g) => !have.has(Number(g)))
    console.log(`  配置要求进的群  : ${[...wanted].join(', ') || '(无)'}`)
    console.log(`  ${missing.length === 0 ? '✅ 全部已加入' : `❌ 还缺 ${missing.length} 个群：${missing.join(', ')}`}`)
  } catch (err) {
    console.error('验收失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error(`OneBot 运行失败（${url}）:`, e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 60000)
