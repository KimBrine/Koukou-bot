import assert from 'node:assert/strict'
import { parseSongRequest, parseMusicRequest, resolveMusicRequest, searchSong } from '../src/music.js'
import { trimTo } from '../src/replyShape.js'

assert.equal(parseSongRequest('点歌 起风了'), '起风了')
assert.equal(parseSongRequest('来一首《孤勇者》'), '孤勇者')
assert.equal(parseSongRequest('我想听稻香'), '稻香')
assert.equal(parseSongRequest('想听这个，发给我', 'River Flows in You'), 'River Flows in You')
assert.equal(parseSongRequest('我想听你说说这件事'), '', '不是点歌，不能误判')
assert.equal(parseSongRequest('今天天气不错'), '')
const parsed=parseMusicRequest('点歌 浮光 周深')
assert.equal(parsed.platform,'163');assert.equal(parsed.title,'浮光');assert.equal(parsed.artist,'周深')
for(const request of ['点歌 周深唱的浮光','想听周深的《浮光》','来一首《浮光》 周深']){
  const r=parseMusicRequest(request);assert.equal(r.title,'浮光');assert.equal(r.artist,'周深')
}
assert.equal(parseMusicRequest('QQ音乐 点歌 浮光 周深').platform,'qq')
assert.equal(parseMusicRequest('点歌 43601648').id,'43601648','不能补位或偷偷改ID')
const linked=parseMusicRequest('点歌 https://music.163.com/song?id=436016480&uct2=ignored')
assert.equal(linked.id,'436016480');assert.equal(linked.platform,'163')
assert.equal(parseMusicRequest('想听这个，发给我','https://music.163.com/#/song?id=436016480').id,'436016480')
assert.equal(parseMusicRequest('点歌 https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV').idKind,'mid')
assert.equal(parseMusicRequest('点歌 QQ音乐 id 97773').id,'97773')
assert.match(parseMusicRequest('点歌 QQ音乐 https://music.163.com/song?id=436016480').error,/不一致/)
assert.match(parseMusicRequest('点歌 酷狗音乐 浮光').error,/只支持/)
assert.match(parseMusicRequest('点歌 https://localhost/song?id=1').error,/完整/)
assert.equal(parseMusicRequest('把文件发给我','某个文件'),null,'引用普通消息不是点歌')
let aiCalls=0
const llm={async chat(){aiCalls++;return JSON.stringify({title:'Love Story',artist:'Taylor Swift'})}}
const natural=await resolveMusicRequest('点歌 Love Story Taylor Swift','',{llm})
assert.equal(natural.title,'Love Story');assert.equal(natural.artist,'Taylor Swift')
await resolveMusicRequest('点歌 436016480','',{llm});assert.equal(aiCalls,1,'ID绝不交给模型改写')
const hallucinated=await resolveMusicRequest('点歌 浮光 周深的版本','',{llm:{chat:async()=>'{"title":"无关歌曲","artist":"另一个人"}'}})
assert.ok(hallucinated.error,'拒绝模型编造输入中没有的歌名/歌手')

const fake = async () => ({ ok: true, status: 200, json: async () => ({ result: { songs: [{ id: 123, name: '起风了', artists: [{ name: '买辣椒也用券' }] }] } }) })
const song = await searchSong('起风了', { fetchImpl: fake })
assert.equal(song.id, '123')
assert.equal(song.artist, '买辣椒也用券')
assert.ok(song.url.includes('music.163.com'))
assert.equal(await searchSong('', { fetchImpl: fake }), null)
const rankedFake=async()=>({ok:true,json:async()=>({result:{songs:[{id:1,name:'若梦',artists:[{name:'周深'}]},{id:2,name:'浮光',artists:[{name:'其他人'}]},{id:3,name:'浮光',artists:[{name:'周深'}]}]}})})
assert.equal((await searchSong(parsed,{fetchImpl:rankedFake})).id,'3','不能直接取错误首项或其他歌手的同名歌')
assert.equal(await searchSong({...parsed,artist:'不存在'},{fetchImpl:rankedFake}),null)
let calls=[]
const idFake=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({songs:[{id:436016480,name:'404 not found',artists:[{name:'REOL'}]}]})}}
const byID=await searchSong(linked,{fetchImpl:idFake})
assert.equal(byID.id,'436016480');assert.equal(byID.artist,'REOL')
assert.ok(calls[0].url.includes('/api/song/detail/'));assert.ok(!calls[0].url.includes('uct2'))
assert.equal(await searchSong({...linked,id:'43601648'},{fetchImpl:idFake}),null,'ID详情不匹配必须拒绝')
const qqFake=async(url,opt)=>{
  const p=JSON.parse(opt.body).req.param;assert.equal(p.song_mid,'0039MnYb0qxYhV')
  return {ok:true,json:async()=>({req:{code:0,data:{track_info:{id:97773,mid:p.song_mid,name:'晴天',singer:[{name:'周杰伦'}]}}}})}
}
const qqSong=await searchSong(parseMusicRequest('点歌 QQ音乐 MID 0039MnYb0qxYhV'),{fetchImpl:qqFake})
assert.equal(qqSong.id,'97773');assert.equal(qqSong.platform,'qq')
await assert.rejects(searchSong(parsed,{fetchImpl:async()=>({ok:false,status:503})}),/503/)

const link = 'https://www.bilibili.com/video/BV1xx411c7mD'
const out = trimTo('B站有，搜这个链接：' + link + ' 你看看', 20)
assert.ok(out.includes(link), '链接不能被截断：' + out)

console.log('点歌与链接保护检查通过：意图解析 / 搜索 / 链接不截断')
