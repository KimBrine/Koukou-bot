import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createImageCache, imageReferenceKeys } from '../src/imageCache.js'
import { createBot } from '../src/bot.js'
import { VISION_DESCRIBE_ASK } from '../src/visionNote.js'

const root = mkdtempSync(path.join(tmpdir(), 'qq-image-cache-'))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64')
const part = { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }
const other = { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.concat([png, Buffer.from('other')]).toString('base64')}` } }
const img = { file: `${'a'.repeat(32)}.png`, url: 'https://gchat.qpic.cn/download?appid=1&fileid=one&rkey=old&spec=0' }
const logger = { info() {}, warn() {}, debug() {}, error(message) { throw Error(message) } }
let passed = 0
let tick = Date.now()
function cache(name, options = {}) { return createImageCache({ dir: path.join(root, name), logger, now: () => tick, ...options }) }
async function test(name, task) { await task(); console.log(`PASS ${name}`); passed++ }
try {
  await test('相同 QQ MD5 / 变化的 rkey 直接复用，重启也不下载', async () => {
    const c = cache('repeat'); let downloads = 0
    const load = () => { downloads++; return part }
    const first = await c.load(img, load)
    const changed = { ...img, url: img.url.replace('old', 'new') }
    assert.equal((await c.load(changed, load)).hash, first.hash)
    assert.equal((await cache('repeat').load(changed, load)).hash, first.hash)
    assert.equal(downloads, 1)
  })
  await test('QQ fileid 单独也能识别变化的 rkey', async () => {
    const c = cache('fileid'); let downloads = 0
    await c.load({ url: img.url }, () => { downloads++; return part })
    await c.load({ url: img.url.replace('old', 'new') }, () => { downloads++; return part })
    assert.equal(downloads, 1)
  })
  await test('普通文件名和不同 URL 查询内容不能混淆', async () => {
    const c = cache('different')
    const a = await c.load({ file: 'image.png', url: 'https://example.test/image?id=1' }, () => part)
    const b = await c.load({ file: 'image.png', url: 'https://example.test/image?id=2' }, () => other)
    assert.notEqual(a.hash, b.hash)
    assert.notDeepEqual(imageReferenceKeys({ url: 'https://example.test/image?id=1' }), imageReferenceKeys({ url: 'https://example.test/image?id=2' }))
  })
  await test('同一内容不同标识只存一个文件并复用识图描述', async () => {
    const c = cache('content'); let reads = 0
    const a = await c.load(img, () => part)
    await c.describe([a.hash], 'model1', () => { reads++; return '橘猫' })
    const b = await c.load({ file: `${'b'.repeat(32)}.gif` }, () => part)
    assert.equal(await c.describe([b.hash], 'model1', () => { reads++; return '不应执行' }), '橘猫')
    assert.equal(c.stats().images, 1); assert.equal(reads, 1)
    assert.equal(readdirSync(path.join(root, 'content')).filter(name => name.endsWith('.bin')).length, 1)
  })
  await test('切换模型与多图顺序变化必须重新识别', async () => {
    const c = cache('scope')
    const a = await c.load(img, () => part)
    const b = await c.load({ file: `${'b'.repeat(32)}.png` }, () => other)
    assert.equal(await c.describe([a.hash,b.hash], 'model1', () => '猫和狗'), '猫和狗')
    assert.equal(await c.describe([a.hash,b.hash], 'model2', () => '新模型描述'), '新模型描述')
    assert.equal(await c.describe([b.hash,a.hash], 'model1', () => '狗和猫'), '狗和猫')
  })
  await test('识图描述持久化，失败和空描述不缓存', async () => {
    const c = cache('description'); const a = await c.load(img, () => part)
    await assert.rejects(c.describe([a.hash], 'model1', () => { throw Error('接口失败') }), /接口失败/)
    await assert.rejects(c.describe([a.hash], 'model1', () => ''), /空描述/)
    await c.describe([a.hash], 'model1', () => '橘猫')
    assert.equal(await cache('description').describe([a.hash], 'model1', () => { throw Error('不应调用') }), '橘猫')
  })
  await test('并发重复图片只下载一次、只识图一次', async () => {
    const c = cache('concurrent'); let downloads = 0; let reads = 0
    const load = async () => { downloads++; await new Promise(r => setTimeout(r, 20)); return part }
    const [a,b] = await Promise.all([c.load(img, load), c.load(img, load)])
    const generate = async () => { reads++; await new Promise(r => setTimeout(r, 20)); return '橘猫' }
    assert.deepEqual(await Promise.all([c.describe([a.hash], 'model', generate),c.describe([b.hash], 'model', generate)]), ['橘猫','橘猫'])
    assert.equal(downloads,1); assert.equal(reads,1)
  })
  await test('缓存损坏时重新获取，不能返回错误图片', async () => {
    const c = cache('corrupt'); const a = await c.load(img, () => part)
    writeFileSync(path.join(root,'corrupt',`${a.hash}.bin`), 'broken')
    let downloads = 0
    assert.equal((await c.load(img, () => { downloads++; return part })).hash, a.hash)
    assert.equal(downloads,1)
  })
  await test('过期记录自动清理，图片和描述重新获取', async () => {
    const c = cache('ttl', { ttlMs:100 })
    const a = await c.load(img, () => part)
    await c.describe([a.hash], 'model', () => '旧描述')
    tick += 101
    let downloads = 0
    const b = await c.load(img, () => { downloads++; return part })
    assert.equal(downloads,1)
    assert.equal(await c.describe([b.hash], 'model', () => '新描述'), '新描述')
  })
  await test('磁盘大小与数量上限按最久未使用淘汰', async () => {
    const c = cache('capacity', { maxBytes:png.length+1, maxEntries:1 })
    await c.load(img, () => part); tick++
    await c.load({file:`${'b'.repeat(32)}.png`}, () => other)
    // other 超过整个缓存容量，只返回本次结果，不挤占磁盘。
    assert.ok(c.stats().bytes <= png.length+1); assert.equal(c.stats().images,1)
    const d = cache('lru', { maxEntries:1 })
    await d.load(img, () => part); tick++
    await d.load({file:`${'b'.repeat(32)}.png`}, () => other)
    assert.equal(d.stats().images,1)
    let downloads=0
    await d.load(img, () => { downloads++; return part })
    assert.equal(downloads,1)
  })
  await test('实际机器人路径：两轮回复只下载和识图一次，回复独立生成', async () => {
    const originalFetch = globalThis.fetch
    let downloads=0, reads=0, replies=0; const sent=[]
    globalThis.fetch = async () => { downloads++; return new Response(png) }
    const config = {dataDir:path.join(root,'bot'), quietHours:'',whitelistGroups:new Set(),visionMaxImages:4,visionMaxImageBytes:1024,visionImageTimeoutMs:100,contextRememberAll:true,replyMaxLines:1,replyLineMaxChars:40,emojiKeepRate:0,humanDelayMinMs:0,humanDelayMaxMs:0}
    const memory = {items:[],get(){return this.items},push(key,role,content){this.items.push({role,content})}}
    const visionLLM={baseUrl:'https://model.test',model:'vision',async describeImages(system,text){assert.equal(text,VISION_DESCRIBE_ASK);reads++;return '橘猫睡在键盘上'}}
    const options={config,logger,onebot:{selfId:'999',async sendPrivate(id,text){sent.push(text)}},memory,visionLLM,llm:{async chat(){replies++;return '这猫睡得真香'}},buildSystemPrompt:()=>'',rand:()=>1}
    const evt={message_type:'private',user_id:'100',sender:{nickname:'测试'},message:[{type:'image',data:img},{type:'text',data:{text:'看看'}}]}
    try {
      const bot=createBot(options)
      await bot.handleMessage(evt); await bot.handleMessage(evt)
      await createBot(options).handleMessage({...evt,user_id:'101'})
      assert.equal(downloads,1);assert.equal(reads,1);assert.equal(replies,3);assert.equal(sent.length,3)
    } finally {globalThis.fetch=originalFetch}
  })
  console.log(`${passed} cases passed`)
} finally {
  const resolved = path.resolve(root)
  if (!resolved.startsWith(path.join(path.resolve(tmpdir()),'qq-image-cache-'))) throw Error('测试清理路径越界')
  rmSync(resolved, {recursive:true,force:true})
}
