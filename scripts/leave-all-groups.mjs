/**
 * 让某个账号退出它所在的**全部**群 —— 只在"退役旧机器人号"时用。
 *
 *   node scripts/leave-all-groups.mjs [ws://127.0.0.1:3001]            # 干跑，只列出来
 *   node scripts/leave-all-groups.mjs ws://127.0.0.1:3001 --yes        # 真的退群
 *
 * ⚠️ 退群不可逆：要回去只能被群主/管理员重新拉进群。
 * ⚠️ 必须在账号还登录着的时候做 —— 一旦登出就退不了群了。
 *
 * 默认是干跑（只打印将要退出哪些群），必须显式加 --yes 才会真的执行。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'

const args = process.argv.slice(2)
const url = args.find((a) => a.startsWith('ws')) || process.env.ONEBOT_WS_URL || loadConfig().onebotWsUrl
const confirmed = args.includes('--yes')
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url, logger })

onebot.on('ready', async () => {
  try {
    console.log(`连接的 OneBot：${url}`)
    console.log(`账号：${onebot.selfId}  昵称：${onebot.nickname}`)
    console.log(confirmed ? '\n模式：真的退群（--yes）\n' : '\n模式：干跑（只列出，不执行）—— 要真退请加 --yes\n')

    const groups = await onebot.getGroupList()
    const list = Array.isArray(groups) ? groups : (groups?.data ?? [])
    if (list.length === 0) {
      console.log('这个账号不在任何群里，无需操作。')
      onebot.stop()
      process.exit(0)
    }

    let done = 0
    for (const g of list) {
      const gid = g.group_id ?? g.groupId
      const name = g.group_name ?? ''
      const count = g.member_count ?? '?'
      if (!confirmed) {
        console.log(`  [将退出] ${gid}  ${name}  (${count} 人)`)
        continue
      }
      try {
        await onebot.setGroupLeave(gid, false)
        done++
        console.log(`  ✅ 已退出 ${gid}  ${name}`)
      } catch (err) {
        console.log(`  ❌ 退出 ${gid} 失败：${err.message}`)
      }
      await new Promise((r) => setTimeout(r, 1200)) // 别连珠炮，给腾讯一点喘息
    }

    console.log(confirmed ? `\n完成：退出 ${done}/${list.length} 个群` : `\n共 ${list.length} 个群待退出（干跑，未执行）`)
    if (confirmed) {
      const left = await onebot.getGroupList().catch(() => [])
      const rest = Array.isArray(left) ? left : (left?.data ?? [])
      console.log(`复查：现在还在 ${rest.length} 个群里${rest.length ? ' → ' + rest.map((x) => x.group_id).join(',') : ' ✅'}`)
    }
  } catch (err) {
    console.error('执行失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error(`OneBot 运行失败（${url}）:`, e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 120000)
