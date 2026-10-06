/**
 * 查指定昵称/名片的人在群里的当前状态（核实名单为什么变了）。
 *   node scripts/probe-member-names.mjs [群号] 名字1 名字2 ...
 * 只读，不发消息。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'
import { checkName, displayName, isLikelyBot } from '../src/idCheck.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || 1124442491)
const wanted = process.argv.slice(3)

onebot.on('ready', async () => {
  try {
    const members = await onebot.getGroupMemberList(group)
    console.log(`群 ${group} 共 ${members.length} 人\n`)

    console.log('=== 指定的人 ===')
    for (const w of wanted) {
      // 支持 qq:123456 或裸 8 位以上数字按 QQ 查，其余按名字/名片模糊匹配
      const byQq = /^qq:/i.test(w) || /^\d{8,}$/.test(w)
      const qq = w.replace(/^qq:/i, '')
      const hits = byQq
        ? members.filter((m) => String(m.user_id) === qq)
        : members.filter((m) => displayName(m).includes(w) || String(m.nickname || '').includes(w))
      if (hits.length === 0) {
        console.log(`  「${w}」→ ${byQq ? '不在这个群里' : '不在群里（或已改名）'}`)
        continue
      }
      for (const m of hits) {
        const name = displayName(m)
        const r = checkName(name)
        console.log(
          `  「${w}」→ QQ ${m.user_id}｜名片="${m.card}"｜昵称="${m.nickname}"｜核对名="${name}"｜` +
            `${r.ok ? `合格（房间号 ${r.room}）` : `不合格（${r.reason}）`}｜is_robot=${m.is_robot}｜像机器人=${isLikelyBot(m)}`
        )
      }
    }

    console.log('\n=== 全部不合格名单（实时）===')
    const bad = members.filter((m) => !isLikelyBot(m) && String(m.user_id) !== String(onebot.selfId) && !checkName(displayName(m)).ok)
    console.log(`  共 ${bad.length} 人：${bad.map((m) => `${displayName(m)}(` + `${m.user_id})`).join('、')}`)
  } catch (err) {
    console.error('查询失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 45000)
