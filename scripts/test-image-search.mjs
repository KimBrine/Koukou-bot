// 离线：联网找图（必应图片解析、搜索词、下载校验），不联网
import assert from 'node:assert/strict'
import { buildStickerQuery, collectWebImages, relevantImageResult, searchDomesticImages, collectImageUrls, downloadImage, findWebImage, imageSize, parseBingImageResults, searchCustomImages, searchGiphy, searchTenor, sniffMime } from '../src/imageSearch.js'

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
  async arrayBuffer() { const b=Buffer.alloc(size, 1); if(type==='image/jpeg'){b[0]=0xff;b[1]=0xd8} else if(type==='image/png')png.copy(b,0,0,Math.min(size,png.length)); return b },
})

const image = await downloadImage('https://a.example/1.jpg', { fetchImpl: fakeFetch(true, 'image/jpeg') })
check('下载后转成 data URL', image.dataUrl.startsWith('data:image/jpeg;base64,') && image.buffer.length === 4096)
check('按文件头识别图片类型（代理无响应头时）', sniffMime(png) === 'image/png')
const noType = await downloadImage('https://a.example/n.png', { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, async text() { return '' }, async arrayBuffer() { return png } }) })
check('没有 content-type 也能按文件头接受', noType.mime === 'image/png')
check('PNG 宽高可读出', imageSize(png)?.width === 300)

const tiny = Buffer.alloc(2048, 1); png.copy(tiny,0,0,4); tiny.writeUInt32BE(64, 16); tiny.writeUInt32BE(64, 20)
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

for (const name of ['初音未来','拉普兰德','发条猫','来栖川']) check('保留角色名 '+name, buildStickerQuery('帮我找张'+name+'的表情包') === name+' 表情包')
const amp = parseBingImageResults('<a m="{&quot;murl&quot;:&quot;https://x.example/a.png?a=1&amp;b=2&quot;,&quot;t&quot;:&quot;开心表情包&quot;}"></a>')
check('必应元数据保留带参数直链和标题', amp[0].url === 'https://x.example/a.png?a=1&b=2' && amp[0].title === '开心表情包')
check('标题相关性排除邮票，保留角色相关候选', !relevantImageResult({title:'中国邮政特种邮票'},'拉普兰德 表情包') && relevantImageResult({title:'拉普兰德可爱反应图'},'明日方舟 拉普兰德 表情包'))
let cancelled=false
await assert.rejects(downloadImage('https://x.example/oversize',{maxBytes:1000,fetchImpl:async()=>({ok:true,headers:{get:()=>''},body:{getReader:()=>({read:async()=>({value:Buffer.alloc(1024),done:false}),cancel:async()=>cancelled=true,releaseLock(){}})}})}),/图片太大/)
check('流式下载超限立即停止', cancelled)
await assert.rejects(downloadImage('https://x.example/fake',{fetchImpl:async()=>({ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>Buffer.alloc(4096,1)})}),/不是支持的图片/)
const domestic=await searchDomesticImages('猫猫',{fetchImpl:async()=>({ok:true,json:async()=>({data:[{middleURL:'https://x.example/a',fromPageTitle:'可爱<strong>猫猫</strong>表情包'}]})})})
check('备用来源支持无扩展名图片直链并保留标题',domestic[0].url==='https://x.example/a'&&domestic[0].title==='可爱猫猫表情包')
const order=[]
await collectWebImages(['开心 表情包','难过 表情包'],{limit:2,count:2,minBytes:1024,fetchImpl:async url=>{
 if(url.includes('bing.com')){const q=new URL(url).searchParams.get('q');return {ok:true,text:async()=>[1,2].map(i=>'<a m="'+JSON.stringify({murl:'https://x.example/'+encodeURIComponent(q)+i+'.png',t:q}).replace(/"/g,'&quot;')+'"></a>').join('')}}
 order.push(decodeURIComponent(url));const bytes=Buffer.from(png);bytes[30]=order.length
 return {ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>bytes}
}})
check('轮流下载不同关键词的候选，不让首词占满', order.length===2&&order[0].includes('开心')&&order[1].includes('难过'))

console.log(`image search checks passed: ${pass}`)