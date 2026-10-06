import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'

const config = loadConfig()
const logger = createLogger('info', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const GID = config.targetWatchGroup
const UID = config.targetWatchUser

onebot.on('ready', async () => {
  console.log(`== 测试向群 ${GID} 发送 @${UID} 的消息（发完立刻撤回）==`)
  try {
    // 用与盯人回复完全相同的消息段结构
    const res = await onebot.sendGroup(GID, [
      { type: 'at', data: { qq: UID } },
      { type: 'text', data: { text: ' 格式测试，马上撤回～' } },
    ])
    console.log('✅ 发送成功，message_id =', res?.message_id)
    // 立刻撤回
    await new Promise((r) => setTimeout(r, 800))
    const del = await onebot.api('delete_msg', { message_id: res?.message_id })
    console.log('✅ 已撤回', del === undefined || del === null ? '' : JSON.stringify(del))
    // 再测一次故意"漏写 data"的旧写法，验证 normalizeSegments 的兜底
    const res2 = await onebot.sendGroup(GID, [
      { type: 'text', text: '兜底测试（漏写 data），马上撤回～' },
    ])
    console.log('✅ 兜底格式也能发送，message_id =', res2?.message_id)
    await new Promise((r) => setTimeout(r, 800))
    await onebot.api('delete_msg', { message_id: res2?.message_id })
    console.log('✅ 已撤回')
    console.log('\n结论：@ 消息段格式已修复，盯人回复可以正常发送')
  } catch (e) {
    console.error('❌ 失败:', e.message)
  }
  onebot.stop()
  process.exit(0)
})

onebot.run().catch((e) => {
  console.error('OneBot 运行失败:', e.message)
  process.exit(1)
})
setTimeout(() => process.exit(2), 60000)
