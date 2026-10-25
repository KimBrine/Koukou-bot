// Pure fixture comparisons only; no QQ, HTTP or model request is made.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {checkName,checkMembers,buildReminderMessages,canKickNow,canRunIdCheck,ID_CHECK_CMD_RE,ID_CHECK_KICK_CMD_RE} from '../src/idCheck.js'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const names=[null,'','604','604方铁','604 方铁','６０４方铁','1009','707-吴钧皓','502王五','1102赵六','6045名字','东d702昵称','60','100','106','10000','٦٠٤名字','【店员】猫','604\n名字','\u3000604\u3000昵称','90','10','100a','1099a','01009','６０４５','11111','房间604']
const roster=[{user_id:1,card:'604操作员',role:'member'},{user_id:2,card:'【摸鱼】小明',role:'member'},{user_id:3,card:'【店员】猫'},{user_id:4,card:'群助手'},{user_id:5,card:'小助手'},{user_id:6,card:'６０４ 全角'},{user_id:7,card:'bad',is_robot:true},{user_id:8,nickname:'1009名字'},{user_id:9,card:'',nickname:'空'},{card:'缺账号'}]
const memberCases=[]
for(const selfId of ['','2'])for(const skipBots of [false,true])for(const skip of [[],['9']])memberCases.push({members:roster,options:{selfId,skipBots,skip}})
const bad=checkMembers(roster).bad
const reminders=[0,1,2,10,-1].map(perMessage=>({bad,options:{perMessage,reminder:'请修改名片'}}))
const kicks=[]
for(const operators of [[],['11'],['12']])for(const isBotAdmin of [false,true])for(const age of [-1,0,300000,300001])for(const kicked of [false,true])for(const group of [22,23])kicks.push({record:{group_id:22,at:1000000,bad,kicked},groupId:group,userId:11,operators,now:1000000+age,isBotAdmin})
kicks.push({record:null,groupId:22,userId:11,operators:[11],now:1000000,isBotAdmin:true})
const commands=['/id_check','／idcheck','id check','/查名片','名字核对。','/id_check_kick','核对踢人','查名片踢人','/id_check /id_check_kick','帮我/id_check','id--check','/id check kick！']
const code=`import json,sys
from koukou.id_check import check_name,check_members,build_reminder_messages,can_kick_now,can_run_id_check,ID_CHECK_CMD_RE,ID_CHECK_KICK_CMD_RE
d=json.load(sys.stdin)
def members(v):
 o=v['options']; return check_members(v['members'],self_id=o['selfId'],skip=o['skip'],skip_bots=o['skipBots'])
def reminder(v):
 return build_reminder_messages(v['bad'],per_message=v['options']['perMessage'],reminder=v['options']['reminder'])
def kick(v):
 return can_kick_now(record=v['record'],group_id=v['groupId'],user_id=v['userId'],operators=v['operators'],now=v['now'],is_bot_admin=v['isBotAdmin'])
json.dump({'names':[check_name(v) for v in d['names']], 'members':[members(v) for v in d['memberCases']], 'reminders':[reminder(v) for v in d['reminders']], 'kicks':[kick(v) for v in d['kicks']], 'commands':[[bool(ID_CHECK_CMD_RE.fullmatch(v)),bool(ID_CHECK_KICK_CMD_RE.fullmatch(v))] for v in d['commands']], 'operators':[can_run_id_check(11,v) for v in [[],[11],[12]]]},sys.stdout,ensure_ascii=False)
`
const run=spawnSync(process.env.KOUKOU_PYTHON||'python',['-X','utf8','-c',code],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'python')},input:JSON.stringify({names,memberCases,reminders,kicks,commands}),encoding:'utf8',maxBuffer:4*1024*1024})
assert.equal(run.status,0,run.stderr)
const result=JSON.parse(run.stdout)
assert.deepEqual(result.names,names.map(checkName))
assert.deepEqual(result.members,memberCases.map(v=>checkMembers(v.members,v.options)))
assert.deepEqual(result.reminders,reminders.map(v=>buildReminderMessages(v.bad,v.options)))
assert.deepEqual(result.kicks,kicks.map(canKickNow))
assert.deepEqual(result.commands,commands.map(v=>[ID_CHECK_CMD_RE.test(v),ID_CHECK_KICK_CMD_RE.test(v)]))
assert.deepEqual(result.operators,[[],[11],[12]].map(v=>canRunIdCheck(11,v)))
console.log(`Python名片核对差分通过：${names.length}种名字、${memberCases.length}份名单、${kicks.length}项踢人门槛与${commands.length}种指令。`)
