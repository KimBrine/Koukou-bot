// Offline cross-language parity: invoke only pure Python functions, no services or credentials.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import { decideReply } from '../src/bot.js'
import { plusOneFingerprint } from '../src/autoPlusOne.js'
import { parseMuteDuration } from '../src/groupMute.js'
import { greetingWindow } from '../src/quietGreetings.js'
import { commandScopeAllows } from '../src/customCommands.js'
import { parseMusicRequest } from '../src/music.js'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const cases=[]
const now=new Date(2026,0,2,2).getTime()
for(const privateChat of [false,true])for(const atBot of [false,true])for(const enabled of [false,true])for(const quiet of ['', '01:00-07:00'])for(const rate of [0,.35,1])for(const random of [.01,.8])for(const blocked of [false,true]){
 const config={whitelistGroups:[200000002],mutedGroups:blocked?[200000002]:[],privateWhitelist:[200000011],adminUsers:[],quietHours:quiet,quietHoursBlockAll:true,proactiveRate:rate,proactiveCooldownMs:30000}
 cases.push({privateChat,atBot,config,settings:{enabled,quietHours:null,proactiveRate:null},random,now,group:200000002,user:200000011,last:0})
}
const fingerprints=['hello','💀','[CQ:face,id=66]','你好[CQ:face,id=66]','[CQ:image,file=x]','/help','群总结',[
 {type:'text',data:{text:'甲 ' }},{type:'text',data:{text:'💀'}},{type:'face',data:{id:'066'}}], '&amp;&copy;', '[CQ:face,id=66,resultId=0]']
const durations=[null,'10s','1秒','十分钟','1小时30分钟','半小时','1.5天','(2+3)秒','2^3分钟','sqrt(9)分钟','3!秒','01:02:03','100毫秒','31天','永久','0秒','-1秒','10分钟或20分钟','2分钟+3秒','(1/3)秒','2*pi秒','log10(100)分钟','2秒*3秒','1分钟/0','5','三点五小时','一万秒','2周','1分钟-30秒']
const windows=[]
for(const spec of ['23:00-07:00','01:00-07:00','07:00-09:00','00:00-00:00','25:00-07:00','invalid'])for(const h of [0,1,6,7,8,9,15,22,23])windows.push({spec,at:Date.UTC(2026,0,2,h)})
const scopes=[]
const songs=['点歌 浮光 周深','点歌 436016480','点歌 QQ音乐 123456','点歌 周深唱的浮光','点歌 周深的《浮光》','点歌 《浮光》 周深','点歌 浮光 歌手：周深','想听 404 not found REOL','点歌 Never Gonna Give You Up','点歌 MID 003AAAAAAA','QQ音乐 点歌 mid 003AAAAAAA','点歌 https://music.163.com/song?id=436016480','https://y.qq.com/n/ryqq/songDetail/003AAAAAAA','点歌 网易云 QQ音乐 浮光','点歌 Spotify test','点歌 你唱的歌','聊聊音乐','/music 浮光 周深','点歌 https://example.invalid/song?id=1','点歌 网易云 https://y.qq.com/n/ryqq/songDetail/003AAAAAAA'].map(text=>({text,quoted:''}))
songs.push({text:'听这首',quoted:'https://music.163.com/song?id=436016480'})
for(const scope of ['all','group','groups','private'])for(const isPrivate of [false,true])for(const groupId of [100,200])scopes.push({command:{scope,groups:[100]},context:{isPrivate,groupId}})
const code=`import json,sys
from koukou.policy import decide_reply
from koukou.messages import repeat_fingerprint
from koukou.duration import parse_duration
from koukou.quiet_greetings import greeting_window
from koukou.custom import scope_allows
from koukou.music import parse_music_request
def duration(value):
 try: return parse_duration(value)
 except (ValueError,OverflowError,ZeroDivisionError): return {'invalid':True}
d=json.load(sys.stdin)
values=[decide_reply(private=c['privateChat'],at_bot=c['atBot'],config=c['config'],settings=c['settings'],group=c['group'],user=c['user'],now=c['now']/1000,last_proactive=c['last'],rand=lambda c=c:c['random']) for c in d['cases']]
print(json.dumps({'cases':values,'songs':[parse_music_request(v['text'],v['quoted']) for v in d['songs']],'windows':[greeting_window(v['spec'],v['at']) for v in d['windows']],'scopes':[scope_allows(v['command'],v['context']) for v in d['scopes']],'durations':[duration(value) for value in d['durations']],'fingerprints':[repeat_fingerprint(raw) for raw in d['fingerprints']]},ensure_ascii=False))`
const result=spawnSync(process.env.KOUKOU_PYTHON||'python',['-X','utf8','-c',code],{cwd:root,encoding:'utf8',input:JSON.stringify({cases,fingerprints,durations,windows,scopes,songs}),env:{...process.env,PYTHONPATH:path.join(root,'python'),PYTHONUTF8:'1'},windowsHide:true})
assert.equal(result.status,0,result.stderr)
const actual=JSON.parse(result.stdout), oldRandom=Math.random
try{
 for(const [i,c]of cases.entries()){
  Math.random=()=>c.random
  const config={...c.config,whitelistGroups:new Set(c.config.whitelistGroups),mutedGroups:new Set(c.config.mutedGroups),privateWhitelist:new Set(c.config.privateWhitelist),adminUsers:new Set()}
  const expected=decideReply({isPrivate:c.privateChat,atBot:c.atBot,groupId:c.group,config,lastProactive:new Map(),chatSettings:{get:()=>c.settings,raw:()=>null},chatKey:c.privateChat?'p'+c.user:'g'+c.group,now:c.now})
  assert.deepEqual(actual.cases[i],expected,JSON.stringify(c))
 }
 assert.deepEqual(actual.fingerprints,fingerprints.map(plusOneFingerprint))
 assert.deepEqual(actual.windows,windows.map(v=>greetingWindow(v.spec,v.at)))
 assert.deepEqual(actual.scopes,scopes.map(v=>commandScopeAllows(v.command,v.context)))
 for(const [i,song] of songs.entries())assert.deepEqual(actual.songs[i],parseMusicRequest(song.text,song.quoted),song.text)
 for(const [i,value] of durations.entries()){
  let expected; try{expected=parseMuteDuration(value);if(expected.error)expected={invalid:true}}catch{expected={invalid:true}}
  assert.deepEqual(actual.durations[i],expected,`duration ${value}`)
 }
}finally{Math.random=oldRandom}
console.log(`Python/JS parity passed: ${cases.length} reply decisions and ${fingerprints.length} repeat fingerprints. No QQ/model calls.`)
console.log(`Duration parity passed: ${durations.length} Chinese, English, arithmetic and invalid durations.`)
console.log(`Greeting boundary and command scope parity passed: ${windows.length} windows and ${scopes.length} scopes.`)
console.log(`Music parsing parity passed: ${songs.length} requests.`)
const ui=readFileSync(path.join(root,'src/admin/app.js'),'utf8')
const cardCode=ui.slice(ui.indexOf('function pythonCard(){'),ui.indexOf('function syncPyOpen(){'))
const context={pythonScripts:[{id:'hello',command:'问候',name:'问候插件'}],pythonSettings:{recallSeconds:300},pyOpen:{rows:[],editors:[]},pythonDir:'plugins/python',pyDrafts:{},esc:x=>String(x??'')}
for(const native of [false,true]){
 const html=vm.runInNewContext(cardCode+';pythonCard()',{...context,pythonNativeCommands:native})
 assert.ok(html.includes(native?'用法：/问候':'用法：/py 问候'))
 assert.ok(html.includes(native?'插件源码管理':'Python 脚本'))
}
console.log('Native slash command UI and legacy namespace UI both render correctly.')
