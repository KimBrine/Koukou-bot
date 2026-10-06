import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { OneBotClient } from '../src/onebot.js'

const config = loadConfig()
const logger = createLogger('info', null)
const onebot = new OneBotClient({ url: config.onebotWsUrl, logger })
const GID = config.targetWatchGroup

onebot.on('ready', async () => {
  try {
    // 完全模拟盯人回复的发送方式：数组 + @ + 带表情标记的文本
    const res = await onebot.sendGroup(GID, [
      { type: 'at', data: { qq: config.targetWatchUser } },
      { type: 'text', data: { text: ' 数组消息表情自检[表情:害羞]' } },
    ])
    console.log('发送成功 message_id =', res?.message_id)
    await new Promise((r) => setTimeout(r, 1200))

    const got = await onebot.getMsg(res.message_id)
    const segs = Array.isArray(got.message) ? got.message : []
    console.log('读回的消息段：')
    for (const s of segs) {
      if (s.type === 'face') console.log(`  face(id=${s.data?.id} 名称=${s.data?.raw?.faceText ?? '-'})`)
      else if (s.type === 'text') console.log(`  text(${JSON.stringify(s.data?.text)})`)
      else if (s.type === 'at') console.log(`  at(${s.data?.qq})`)
      else console.log(`  ${s.type}`)
    }
    const hasFace = segs.some((s) => s.type === 'face' && Number(s.data?.id) === 6)
    const hasLiteral = segs.some((s) => s.type === 'text' && /\[CQ:face|\[表情/.test(String(s.data?.text || '')))
    console.log(`\n结论：${hasFace && !hasLiteral ? '✅ 已变成真实表情段，无字面量残留' : '❌ 仍有问题'}`)

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
