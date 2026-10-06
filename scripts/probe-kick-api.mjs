import { getProbeTarget } from './probe-settings.mjs'
/**
 * 安全验证 set_group_kick 这个接口本身能不能用（**不碰任何真人**）。
 *
 * 做法：挑一个确定不在群里的 QQ 号去踢，只会拿到 QQ 的报错。
 *   - 如果报的是"成员不存在/不在群里"这类业务错误 → 说明接口名和参数都对，链路是通的
 *   - 如果报的是"不支持的 API / action not found" → 说明接口名写错了
 *
 *   node scripts/probe-kick-api.mjs [群号] [用来试的QQ号]
 * 只读，不会影响任何真实群成员。
 */
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'

const config = loadConfig()
const logger = createLogger('warn', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const group = Number(process.argv[2] || getProbeTarget('group'))
const victim = String(process.argv[3] || '1000000001')

onebot.on('ready', async () => {
  try {
    const members = await onebot.getGroupMemberList(group)
    const inGroup = members.some((m) => String(m.user_id) === victim)
    console.log(`群 ${group} 共 ${members.length} 人`)
    console.log(`试踢目标 QQ ${victim} 在群里吗？ ${inGroup ? '❌ 在！中止（不能拿真人试）' : '✅ 不在（可以安全试）'}`)
    if (inGroup) {
      onebot.stop()
      process.exit(1)
    }

    // 顺便确认机器人自己的角色
    const me = members.find((m) => String(m.user_id) === String(onebot.selfId))
    console.log(`机器人自己的角色：${me?.role ?? '未知'}（踢人需要 admin 或 owner）`)
    if (me?.role !== 'admin' && me?.role !== 'owner') {
      console.log('⚠ 机器人不是管理员，真踢人时接口会被 QQ 拒绝')
    }

    console.log(`\n调用 set_group_kick(group_id=${group}, user_id=${victim}, reject_add_request=false) …`)
    try {
      const res = await onebot.setGroupKick(group, victim, false)
      console.log(`意外成功了？返回：${JSON.stringify(res)}`)
      console.log('（按理不该成功——这个号根本不在群里，说明返回值不可信，需要人工再确认）')
    } catch (err) {
      const msg = String(err.message || '')
      console.log(`接口返回错误：${msg}`)
      if (/不支持|not found|unknown action|不合法|无效的 action/i.test(msg)) {
        console.log('❌ 接口名或参数有问题，需要修 onebot.setGroupKick')
      } else {
        console.log('✅ 接口是通的（错误来自 QQ 业务层，说明 action 名和参数都被正确受理了）')
      }
    }
    console.log('\n注意：set_group_kick 的 reject_add_request 我们固定传 false —— 只是请出去，不顺手拉黑。')
  } catch (err) {
    console.error('探测失败:', err.message)
  }
  onebot.stop()
  process.exit(0)
})
onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 60000)
