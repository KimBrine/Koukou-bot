// Offline cross-language parity: invoke only pure Python functions, no services or credentials.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideReply } from '../src/bot.js'
import { plusOneFingerprint } from '../src/autoPlusOne.js'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const cases=[]
const now=new Date(2026,0,2,2).getTime()
for(const privateChat of [false,true])for(const atBot of [false,true])for(const enabled of [false,true])for(const quiet of ['', '01:00-07:00'])for(const rate of [0,.35,1])for(const random of [.01,.8])for(const blocked of [false,true]){
 const config={whitelistGroups:[200000002],mutedGroups:blocked?[200000002]:[],privateWhitelist:[200000011],adminUsers:[],quietHours:quiet,quietHoursBlockAll:true,proactiveRate:rate,proactiveCooldownMs:30000}
 cases.push({privateChat,atBot,config,settings:{enabled,quietHours:null,proactiveRate:null},random,now,group:200000002,user:200000011,last:0})
}
const fingerprints=['hello','💀','[CQ:face,id=66]','你好[CQ:face,id=66]','[CQ:image,file=x]','/help','群总结',[
 {type:'text',data:{text:'甲 ' }},{type:'text',data:{text:'💀'}},{type:'face',data:{id:'066'}}], '&amp;&copy;', '[CQ:face,id=66,resultId=0]']
const code=`import json,sys
from koukou.policy import decide_reply
from koukou.messages import repeat_fingerprint
d=json.load(sys.stdin)
values=[decide_reply(private=c['privateChat'],at_bot=c['atBot'],config=c['config'],settings=c['settings'],group=c['group'],user=c['user'],now=c['now']/1000,last_proactive=c['last'],rand=lambda c=c:c['random']) for c in d['cases']]
print(json.dumps({'cases':values,'fingerprints':[repeat_fingerprint(raw) for raw in d['fingerprints']]},ensure_ascii=False))`
const result=spawnSync(process.env.KOUKOU_PYTHON||'python',['-X','utf8','-c',code],{cwd:root,encoding:'utf8',input:JSON.stringify({cases,fingerprints}),env:{...process.env,PYTHONPATH:path.join(root,'python'),PYTHONUTF8:'1'},windowsHide:true})
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
}finally{Math.random=oldRandom}
console.log(`Python/JS parity passed: ${cases.length} reply decisions and ${fingerprints.length} repeat fingerprints. No QQ/model calls.`)
