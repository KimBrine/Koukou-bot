import { getProbeTarget } from './probe-settings.mjs'
/**
 * 看看群成员里"像机器人"的账号有哪些可判别的特征。
 *   node scripts/probe-bot-members.mjs [群号]
 * 只读，不发消息。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || getProbeTarget('group'))

const BOTISH = /(群管家|群助手|机器人|小助手|【店员】|【客服】|【机器人】|[Bb]ot$|官方|安全中心|腾讯|QQ空间|QQ会员)/

onebot.on('ready', async () => {
  try {
    const members = await onebot.getGroupMemberList(group)
    console.log(`群 ${group} 共 ${members.length} 人\n`)

    console.log('=== A. 名字像机器人的成员（完整字段）===')
    const hit = members.filter((m) => BOTISH.test(`${m.card || ''} ${m.nickname || ''}`))
    for (const m of hit) console.log(JSON.stringify(m, null, 2))

    console.log('\n=== B. 对照：3 个普通成员 ===')
    const normal = members.filter((m) => !BOTISH.test(`${m.card || ''} ${m.nickname || ''}`)).slice(0, 3)
    for (const m of normal) console.log(JSON.stringify(m, null, 2))

    console.log('\n=== C. 字段取值分布（找可判别字段）===')
    const keys = ['sex', 'age', 'area', 'level', 'qq_level', 'role', 'card_changeable', 'unfriendly']
    for (const k of keys) {
      const dist = new Map()
      for (const m of members) {
        const v = m[k]
        const key = typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? String(v) : String(v)
        dist.set(key, (dist.get(key) || 0) + 1)
      }
      const entries = [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      console.log(`  ${k}: ${entries.map(([v, n]) => `${v}×${n}`).join('  ')}`)
    }

    console.log('\n=== D. 机器人候选的字段对照 ===')
    for (const m of hit) {
      console.log(
        `  ${m.user_id}  card="${m.card}" nick="${m.nickname}" role=${m.role} sex=${m.sex} age=${m.age} ` +
          `area=${JSON.stringify(m.area)} lvl=${m.level} qqlvl=${m.qq_level} cardable=${m.card_changeable}`
      )
    }
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
