// 离线：表情包图片段要按协议端适配——LLBot 用 subType，NapCat 保持 sub_type
import assert from 'node:assert/strict'
import { OneBotClient } from '../src/onebot.js'

const logger = { info() {}, warn() {} }
const clientWith = (appName) => {
  const ob = new OneBotClient({ url: 'ws://127.0.0.1:3002', logger })
  ob.api = async (action) => {
    if (action === 'get_version_info') return { app_name: appName }
    throw new Error('unexpected action ' + action)
  }
  return ob
}

let pass = 0
const check = (name, ok) => { assert.ok(ok, name); pass++; console.log('PASS', name) }

const llbot = clientWith('LLOneBot')
const llbotSeg = await llbot.imageSegment('sticker.gif', { sticker: true })
check('LLBot 只带 subType', llbotSeg.data.subType === 1 && !('sub_type' in llbotSeg.data))
check('LLBot 段类型是 image', llbotSeg.type === 'image' && llbotSeg.data.file === 'sticker.gif')

const napcat = clientWith('NapCatQQ')
const napcatSeg = await napcat.imageSegment('sticker.gif', { sticker: true })
check('NapCat 保持原来的 sub_type', napcatSeg.data.sub_type === 1 && !('subType' in napcatSeg.data))

const unknown = new OneBotClient({ url: 'ws://127.0.0.1:3002', logger })
unknown.api = async () => { throw new Error('unsupported') }
const unknownSeg = await unknown.imageSegment('sticker.gif', { sticker: true })
check('探测失败时两个字段都带（兼容优先）', unknownSeg.data.sub_type === 1 && unknownSeg.data.subType === 1)

const plain = await llbot.imageSegment('photo.jpg', { sticker: false })
check('普通图片不带表情字段', !('sub_type' in plain.data) && !('subType' in plain.data))

check('后端探测只请求一次', llbot.backendCache?.appName === 'LLOneBot')
console.log(`sticker segment checks passed: ${pass}`)
