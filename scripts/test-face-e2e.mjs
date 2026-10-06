import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'

const config = loadConfig()
const logger = createLogger('info', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const GID = config.targetWatchGroup

onebot.on('ready', async () => {
  try {
    // 通过发送层转换（字符串路径）：[表情:doge] 应变成 id=179
    const res = await onebot.sendGroup(GID, '映射自检[表情:doge][表情:笑哭]')
    console.log('发送成功 message_id =', res?.message_id)
    await new Promise((r) => setTimeout(r, 1200))

    // 读回来核对 NapCat 认为这些 id 是什么
    const got = await onebot.getMsg(res.message_id)
    const segs = Array.isArray(got.message) ? got.message : []
    for (const s of segs) {
      if (s.type === 'face') console.log(`  face id=${s.data?.id} → NapCat 名称 "${s.data?.raw?.faceText ?? '(无)'}"`)
      if (s.type === 'text') console.log(`  text ${JSON.stringify(s.data?.text)}`)
    }
    const ids = segs.filter((s) => s.type === 'face').map((s) => Number(s.data?.id))
    console.log(`\n转换结果：${JSON.stringify(ids)}  ${ids.includes(179) && ids.includes(182) ? '✅ 与官方表一致（doge=179, 笑哭=182）' : '❌ 与预期不符'}`)

    await onebot.api('delete_msg', { message_id: res.message_id })
    console.log('测试消息已撤回')
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
