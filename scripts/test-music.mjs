import assert from 'node:assert/strict'
import { parseSongRequest, searchSong } from '../src/music.js'
import { trimTo } from '../src/replyShape.js'

assert.equal(parseSongRequest('点歌 起风了'), '起风了')
assert.equal(parseSongRequest('来一首《孤勇者》'), '孤勇者')
assert.equal(parseSongRequest('我想听稻香'), '稻香')
assert.equal(parseSongRequest('想听这个，发给我', 'River Flows in You'), 'River Flows in You')
assert.equal(parseSongRequest('我想听你说说这件事'), '', '不是点歌，不能误判')
assert.equal(parseSongRequest('今天天气不错'), '')

const fake = async () => ({ ok: true, status: 200, json: async () => ({ result: { songs: [{ id: 123, name: '起风了', artists: [{ name: '买辣椒也用券' }] }] } }) })
const song = await searchSong('起风了', { fetchImpl: fake })
assert.equal(song.id, '123')
assert.equal(song.artist, '买辣椒也用券')
assert.ok(song.url.includes('music.163.com'))
assert.equal(await searchSong('', { fetchImpl: fake }), null)

const link = 'https://www.bilibili.com/video/BV1xx411c7mD'
const out = trimTo('B站有，搜这个链接：' + link + ' 你看看', 20)
assert.ok(out.includes(link), '链接不能被截断：' + out)

console.log('点歌与链接保护检查通过：意图解析 / 搜索 / 链接不截断')
