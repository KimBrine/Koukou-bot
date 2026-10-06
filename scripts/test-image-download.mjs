// 不联网、不发 QQ 消息；复现失效链接、本地缓存和临时下载故障。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { imageToDataUrl } from '../src/bot.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64')
const dir = mkdtempSync(path.join(tmpdir(), 'qq-image-test-'))
const local = path.join(dir, 'image.png')
writeFileSync(local, png)
const config = { visionImageTimeoutMs: 100, visionMaxImageBytes: 1024 }
const logger = { info() {}, warn() {} }
const originalFetch = globalThis.fetch
let passed = 0
async function check(name, task) {
  try { await task(); passed++; console.log(`PASS ${name}`) }
  finally { globalThis.fetch = originalFetch }
}
const isPng = part => assert.equal(part.image_url.url, `data:image/png;base64,${png.toString('base64')}`)
const noCache = { async getImage() { return {} } }
try {
  await check('正常链接直接读取，不调用缓存接口', async () => {
    globalThis.fetch = async () => new Response(png)
    isPng(await imageToDataUrl({ url: 'https://example.test/ok' }, { getImage() { throw Error('不应调用') } }, config, logger))
  })
  await check('HTTP 400 后使用缓存，即使 NapCat 返回同一失效链接', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('expired', { status: 400 }) }
    isPng(await imageToDataUrl({ file: 'hash.png', url: 'https://example.test/expired' }, {
      async getImage(file, timeout) { assert.equal(file, 'hash.png'); assert.equal(timeout, 100); return { file: local, url: 'https://example.test/expired' } },
    }, config, logger))
    assert.equal(calls, 1)
  })
  await check('直接本地 file URL 无需联网', async () => {
    globalThis.fetch = () => { throw Error('不应联网') }
    isPng(await imageToDataUrl({ file: pathToFileURL(local).href }, noCache, config, logger))
  })
  await check('没有原链接时通过 NapCat 取得图片', async () => {
    isPng(await imageToDataUrl({ file: 'hash.png' }, { async getImage() { return { file: local } } }, config, logger))
  })
  await check('缓存路径不存在时使用 NapCat 返回的新链接', async () => {
    const calls = []
    globalThis.fetch = async url => { calls.push(url); return url.endsWith('/new') ? new Response(png) : new Response('', { status: 400 }) }
    isPng(await imageToDataUrl({ file: 'hash.png', url: 'https://example.test/old' }, {
      async getImage() { return { file: path.join(dir, 'missing.png'), url: 'https://example.test/new' } },
    }, config, logger))
    assert.equal(calls.length, 2)
  })
  await check('永久失效链接且无缓存时不无限重试', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('', { status: 400 }) }
    await assert.rejects(imageToDataUrl({ file: 'hash.png', url: 'https://example.test/bad' }, {
      async getImage() { return { url: 'https://example.test/bad' } },
    }, config, logger), /HTTP 400/)
    assert.equal(calls, 1)
  })
  await check('超时后有限重试并恢复', async () => {
    let calls = 0
    globalThis.fetch = async () => { if (++calls === 1) throw new DOMException('timeout', 'AbortError'); return new Response(png) }
    isPng(await imageToDataUrl({ url: 'https://example.test/slow' }, noCache, config, logger))
    assert.equal(calls, 2)
  })
  await check('HTTP 503 持续失败最多请求两次', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }) }
    await assert.rejects(imageToDataUrl({ url: 'https://example.test/503' }, noCache, config, logger), /HTTP 503/)
    assert.equal(calls, 2)
  })
  await check('HTML 错误页不能伪装为 JPEG 送给模型', async () => {
    globalThis.fetch = async () => new Response('<html>error</html>')
    await assert.rejects(imageToDataUrl({ url: 'https://example.test/html' }, noCache, config, logger), /不是支持的图片/)
  })
  await check('下载途中限制大小，保留原有上限', async () => {
    globalThis.fetch = async () => new Response(Buffer.alloc(2048))
    await assert.rejects(imageToDataUrl({ url: 'https://example.test/large' }, noCache, config, logger), /大小上限/)
  })
  await check('空响应报错，不能视为成功识图', async () => {
    globalThis.fetch = async () => new Response('')
    await assert.rejects(imageToDataUrl({ url: 'https://example.test/empty' }, noCache, config, logger), /内容为空/)
  })
  console.log(`${passed} cases passed`)
} finally {
  globalThis.fetch = originalFetch
  unlinkSync(local)
  rmdirSync(dir)
}
