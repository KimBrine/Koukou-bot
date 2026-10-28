// Offline Python/JS parity: pure parsing/validation only, no external requests.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStickerQuery, collectImageUrls, imageSize, parseBingImageResults, relevantImageResult, sniffMime } from '../src/imageSearch.js'
import { decodeBingUrl, parseBingResults } from '../src/search.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const queries = ['给我找张开心的表情包', '请帮我从网上搜索一下一个奶龙生气的贴纸吧！', '奶龙', '随便表情包', '表情包', '再来一张猫猫 表情包', '[图片]找一张捂脸的表情包', '', 'random cat sticker', '能不能给我联网找几张悲伤表情包看看']
const relevant = []
for (const query of ['奶龙 开心 表情包', '猫猫 随机表情包', '搞笑聊天图片', 'happy cat', '帕姆伤心', '😀']) {
  for (const title of ['', '奶龙大笑表情包', '猫猫开心图片', '商品风景', 'cat happy mood', '帕姆伤心 表情包']) relevant.push({ query, item: { title } })
}
const item = { murl: 'https://images.example.invalid/a.png', t: '奶龙 & 开心', purl: 'https://example.invalid/page' }
const escaped = JSON.stringify(item).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
const imageHtml = `<a m="${escaped}"></a><a m="${escaped}"></a><a m='{"murl":"file:///bad.png"}'></a><a m="bad"></a>`
const originalUrl = 'https://example.invalid/news?q=one&lang=zh'
const href = 'https://cn.bing.com/ck/a?u=a1' + Buffer.from(originalUrl).toString('base64url')
const textHtml = `<li class="b_algo"><h2><a href="${href}">标题 &amp; <b>新闻</b></a></h2><p>今日 <script>隐藏</script>事实 &lt;1&gt;</p>`
const urlCases = [href, 'https://example.invalid/page?x=1', '/search?q=test', 'https://cn.bing.com/ck/a?u=other']
const buffers = []
const png = Buffer.alloc(9000, 65); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(200, 16); png.writeUInt32BE(220, 20); buffers.push(png)
const gif = Buffer.alloc(100, 0); gif.write('GIF89a'); gif.writeUInt16LE(120, 6); gif.writeUInt16LE(90, 8); buffers.push(gif)
const jpeg = Buffer.alloc(100, 0); Buffer.from([255, 216, 255, 192, 0, 17, 8]).copy(jpeg); jpeg.writeUInt16BE(240, 7); jpeg.writeUInt16BE(320, 9); buffers.push(jpeg)
buffers.push(Buffer.from('not image'), Buffer.alloc(0))
const nested = { urls: ['https://x.invalid/a.png', 'https://x.invalid/b.webp?q=1', 'ftp://x.invalid/c.gif'], deep: { item: { url: 'https://x.invalid/d.jpg#x' } }, invalid: 'https://x.invalid/not-image' }
const input = { queries, relevant, imageHtml, textHtml, urlCases, buffers: buffers.map(v => v.toString('base64')), nested }
const code = `import base64,json,sys
from koukou.image_search import build_sticker_query,collect_image_urls,image_size,parse_bing_image_results,relevant_image_result,sniff_mime
from koukou.web_search import decode_bing_url,parse_bing_results
d=json.load(sys.stdin)
buffers=[base64.b64decode(v) for v in d['buffers']]
print(json.dumps({'queries':[build_sticker_query(v) for v in d['queries']],'relevant':[relevant_image_result(v['item'],v['query']) for v in d['relevant']],'images':parse_bing_image_results(d['imageHtml']),'text':parse_bing_results(d['textHtml']),'urls':[decode_bing_url(v) for v in d['urlCases']],'types':[sniff_mime(v) for v in buffers],'sizes':[image_size(v) for v in buffers],'nested':collect_image_urls(d['nested'])},ensure_ascii=False))`
const venv = path.join(root, '.venv', 'Scripts', 'python.exe')
const result = spawnSync(process.env.KOUKOU_PYTHON || (existsSync(venv) ? venv : 'python'), ['-X', 'utf8', '-c', code], {
  cwd: root, encoding: 'utf8', windowsHide: true, input: JSON.stringify(input),
  env: { ...process.env, PYTHONPATH: path.join(root, 'python'), PYTHONUTF8: '1' },
})
assert.equal(result.status, 0, result.stderr)
const actual = JSON.parse(result.stdout)
assert.deepEqual(actual.queries, queries.map(buildStickerQuery))
assert.deepEqual(actual.relevant, relevant.map(v => relevantImageResult(v.item, v.query)))
assert.deepEqual(actual.images, parseBingImageResults(imageHtml))
assert.deepEqual(actual.text, parseBingResults(textHtml))
assert.deepEqual(actual.urls, urlCases.map(decodeBingUrl))
assert.deepEqual(actual.types, buffers.map(sniffMime))
assert.deepEqual(actual.sizes, buffers.map(imageSize))
assert.deepEqual(actual.nested, collectImageUrls(nested))
console.log(`Native web parity passed: ${queries.length} queries, ${relevant.length} relevance cases, Bing image/text/redirect parsing, ${buffers.length} image headers/dimensions, nested custom URLs. No QQ/API calls.`)
