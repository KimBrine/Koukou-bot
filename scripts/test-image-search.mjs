// 离线：联网找图（必应图片解析、搜索词、下载校验），不联网
import assert from 'node:assert/strict'
import { buildStickerQuery, collectImageUrls, downloadImage, findWebImage, imageSize, parseBingImageResults, searchCustomImages, searchGiphy, searchTenor } from '../src/imageSearch.js'

let pass = 0
const check = (name, ok) => { assert.ok(ok, name); pass++; console.log('PASS', name) }

const html = '<a m="{&quot;murl&quot;:&quot;https://a.example/1.jpg&quot;,&quot;turl&quot;:&quot;x&quot;}"></a>'
  + '<a m="{&quot;murl&quot;:&quot;https://a.example/1.jpg&quot;}"></a>'
  + '<a m="{&quot;murl&quot;:&quot;https://b.example/2.png&quot;}"></a>'
  + '<a m="{&quot;murl&quot;:&quot;ftp://bad/3.jpg&quot;}"></a>'
const parsed = parseBingImageResults(html)
check('解析 murl 并去重', parsed.length === 2 && parsed[0].url === 'https://a.example/1.jpg')
check('过滤非 http(s)', parsed.every((x) => x.url.startsWith('https://')))

check('搜索词去掉请求用语', buildStickerQuery('给我找张开心的表情包') === '开心 表情包')
check('只剩请求词时补默认表情包', /表情包/.test(buildStickerQuery('给我发张表情包')))

const png = Buffer.alloc(4096, 1)
png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47
png.writeUInt32BE(300, 16); png.writeUInt32BE(300, 20)
const fakeFetch = (ok = true, type = 'image/png', size = png.length) => async (url) => ({
  ok, status: ok ? 200 : 404,
  headers: { get: () => type },
  async text() { return '' },
  async arrayBuffer() { return Buffer.alloc(size, 1) },
})

const image = await downloadImage('https://a.example/1.jpg', { fetchImpl: fakeFetch(true, 'image/jpeg') })
check('下载后转成 data URL', image.dataUrl.startsWith('data:image/jpeg;base64,') && image.buffer.length === 4096)
check('PNG 宽高可读出', imageSize(png)?.width === 300)

const tiny = Buffer.alloc(2048, 1); tiny[0] = 0x89; tiny[1] = 0x50; tiny.writeUInt32BE(64, 16); tiny.writeUInt32BE(64, 20)
let tooSmall = false
try { await downloadImage('https://a.example/s', { minSide: 160, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'image/png' }, async text() { return '' }, async arrayBuffer() { return tiny } }) }) } catch (err) { tooSmall = /尺寸太小/.test(err.message) }
check('拒绝小图标', tooSmall)

let rejected = false
try { await downloadImage('https://a.example/x', { fetchImpl: fakeFetch(true, 'text/html') }) } catch (err) { rejected = /不是支持的图片类型/.test(err.message) }
check('拒绝非图片内容', rejected)

let tooBig = false
try { await downloadImage('https://a.example/x', { fetchImpl: fakeFetch(true, 'image/png', 5 * 1024 * 1024), maxBytes: 1024 }) } catch (err) { tooBig = /图片太大/.test(err.message) }
check('拒绝超大图片', tooBig)

const searchThenDownload = async (url) => {
  if (url.includes('bing.com')) {
    return { ok: true, status: 200, headers: { get: () => 'text/html' }, async text() { return html }, async arrayBuffer() { return Buffer.alloc(0) } }
  }
  if (url.includes('a.example')) throw new Error('第一张下载失败')
  return { ok: true, status: 200, headers: { get: () => 'image/png' }, async text() { return '' }, async arrayBuffer() { return png } }
}
const found = await findWebImage('开心', { fetchImpl: searchThenDownload, minBytes: 1024, minSide: 0 })
check('第一张失败时自动换下一张', found.sourceUrl === 'https://b.example/2.png' && found.dataUrl.startsWith('data:image/png;base64,'))

let requestedUrl = ''
const custom = await searchCustomImages('猫猫', {
  urlTemplate: 'https://api.example/s?q={query}&n={count}&key={key}', key: 'k1',
  fetchImpl: async (url) => { requestedUrl = url; return { ok: true, status: 200, async json() { return { data: [{ pic: 'https://x.example/a.png' }, { url: 'https://x.example/page.html' }] } } } },
})
check('自定义接口替换占位符并只取图片直链', requestedUrl.includes('q=%E7%8C%AB%E7%8C%AB') && requestedUrl.includes('n=10') && custom.length === 1 && custom[0].url === 'https://x.example/a.png')
check('递归收集图片直链会跳过普通网页', collectImageUrls({ a: ['https://x.example/1.gif', 'https://x.example/page'] }).length === 1)

const giphy = await searchGiphy('happy', { key: 'gk', fetchImpl: async () => ({ ok: true, status: 200, async json() { return { data: [{ images: { original: { url: 'https://g.example/1.gif' } } }] } } }) })
check('Giphy 结果转成图片直链', giphy.length === 1 && giphy[0].url === 'https://g.example/1.gif')
const tenor = await searchTenor('happy', { key: 'tk', fetchImpl: async () => ({ ok: true, status: 200, async json() { return { results: [{ media_formats: { gif: { url: 'https://t.example/1.gif' } } }] } } }) })
check('Tenor 结果转成图片直链', tenor.length === 1 && tenor[0].url === 'https://t.example/1.gif')
let noKey = false
try { await searchGiphy('x', { key: '' }) } catch (err) { noKey = /API Key/.test(err.message) }
check('Giphy 没 Key 时明确报错', noKey)

console.log(`image search checks passed: ${pass}`)