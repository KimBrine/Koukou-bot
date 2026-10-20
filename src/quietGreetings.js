import {existsSync,readFileSync} from 'node:fs'
import {personaGreetingHash} from './personaGreetings.js'
import {buildSystemPrompt} from './persona.js'
import {writeJsonAtomic} from './stateFile.js'
import {sessionPersona} from './conversationSessions.js'

const DAY=86400000, OFFSET=8*3600000
const stamp=t=>new Date(t+OFFSET).toISOString().slice(0,10)
/** 北京时间安静时段。active为当前一轮，ended为最近结束一轮，兼容跨午夜。 */
export function greetingWindow(spec,at){
  const m=/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec||'').trim())
  if(!m)return null
  const [sh,sm,eh,em]=m.slice(1).map(Number)
  if(sh>23||eh>23||sm>59||em>59)return null
  const startMin=sh*60+sm,endMin=eh*60+em
  if(startMin===endMin)return null
  const day=Math.floor((at+OFFSET)/DAY)*DAY-OFFSET
  let start=day+startMin*60000
  if(start>at)start-=DAY
  const end=start+((endMin-startMin+1440)%1440)*60000
  return {start,end,quiet:at<end,ended:at>=end?{start,end}:{start:start-DAY,end:end-DAY}}
}
/** 定时只发送已经生成的文案；发送前落盘占位，结果不明时不重复发送。 */
export function createQuietGreetings({config,onebot,chatSettings,memory,logger,file,library,
  now=Date.now,random=Math.random,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),sendGapMs=1200}){
  let state={version:1,activatedAt:null,groups:{},deliveries:{}},blocked=false,timer=null,busy=false,stopped=false
  try{
    if(existsSync(file)){
      const saved=JSON.parse(readFileSync(file,'utf8'))
      if(saved.version!==1||!Number.isFinite(saved.activatedAt)||!saved.groups||!saved.deliveries)throw Error('状态格式不正确')
      state=saved
    }
  }catch(error){blocked=true;logger?.warn?.(`[早晚安] 状态无法读取，暂停发送以避免重复：${error.message}`)}
  let lastAt=now(),lastOnline=false,lastConnection=onebot.ws,lastVersion=onebot.accountStatusVersion
  const log=(message)=>logger?.info?.('[早晚安] '+message)
  function save(){
    if(blocked)throw Error('早晚安状态不可用')
    try{writeJsonAtomic(file,state)}catch(error){blocked=true;throw error}
  }
  function activate(){if(state.activatedAt===null){state.activatedAt=now();save()}}
  function groupContext(groupId){
    const key='g'+groupId,s=chatSettings?.resolve?.(key,config)||{}
    if(s.enabled===false||config.mutedGroups?.has(Number(groupId)))return null
    const spec=s.quietHours??config.quietHours
    if(!greetingWindow(spec,now()))return null
    const persona=s.persona?sessionPersona(config,s.persona).text:defaultPersona()
    const hash=personaGreetingHash(persona)
    return {groupId:Number(groupId),key,spec,hash,persona}
  }
  function contexts(){
    const list=[]
    for(const groupId of config.whitelistGroups||[]){
      try{const ctx=groupContext(groupId);if(ctx)list.push(ctx)}catch(error){logger?.warn?.(`[早晚安] 群 ${groupId} 设置无效：${error.message}`)}
    }
    return list
  }
  function track(ctx,at){
    const previous=state.groups[ctx.groupId]
    if(!previous||previous.spec!==ctx.spec){state.groups[ctx.groupId]={spec:ctx.spec,since:at};save()}
    return state.groups[ctx.groupId]
  }
  function defaultPersona(){return config.persona?.trim()||buildSystemPrompt({botName:config.botName,now:new Date('2000-01-01T00:00:00Z')})}
  function status(){return {enabled:Boolean(config.quietGreetingsEnabled),blocked:blocked||library.isBlocked(),
    groups:contexts().map(ctx=>{const lib=library.get(ctx.persona);return {groupId:ctx.groupId,quietHours:ctx.spec,ready:Boolean(lib?.goodmorning.length&&lib?.goodnight.length),morningCount:lib?.goodmorning.length??0,nightCount:lib?.goodnight.length??0}})}}
  function valid(ctx,kind,cycle,at){
    if(stopped||blocked||!config.quietGreetingsEnabled||!onebot.status?.().online||!config.whitelistGroups?.has(ctx.groupId))return false
    const current=groupContext(ctx.groupId)
    if(!current||current.spec!==ctx.spec||current.hash!==ctx.hash)return false
    const window=greetingWindow(current.spec,at)
    return kind==='night'?window.quiet&&window.start===cycle.start&&at-cycle.start<60000&&cycle.connection===onebot.ws&&cycle.version===onebot.accountStatusVersion:
      !window.quiet&&window.ended.end===cycle.end
  }
  async function send(ctx,kind,cycle){
    const at=now(),key=`${ctx.groupId}:${kind}:${stamp(kind==='night'?cycle.start:cycle.end)}`
    if(state.deliveries[key]||!valid(ctx,kind,cycle,at))return
    const pair=library.get(ctx.persona),choices=pair?.[kind==='night'?'goodnight':'goodmorning']
    if(!choices?.length)return
    const previous=Object.values(state.deliveries).filter(entry=>entry.groupId===ctx.groupId&&entry.kind===kind&&entry.personaHash===ctx.hash).sort((a,b)=>b.at-a.at)[0]?.text
    const candidates=choices.length>1?choices.filter(text=>text!==previous):choices
    const text=candidates[Math.min(candidates.length-1,Math.max(0,Math.floor(random()*candidates.length)))]
    const entry={groupId:ctx.groupId,kind,at,status:'pending',personaHash:ctx.hash,text}
    state.deliveries[key]=entry
    // 必须先持久化才能发送；进程中途退出或发送超时后也不能盲目重发。
    save()
    try{
      if(!valid(ctx,kind,cycle,now())){entry.status='skipped';save();return}
      const result=await onebot.sendGroup(ctx.groupId,[{type:'text',data:{text}}])
      if(result?.message_id==null)throw Error('QQ未返回消息编号，发送结果待核实')
      entry.status='sent';entry.messageId=String(result.message_id);save()
      const current=groupContext(ctx.groupId)
      if(current?.hash===ctx.hash){
        try{memory?.push?.(ctx.key,'assistant',text,{time:at,messageId:entry.messageId})}
        catch(error){logger?.warn?.(`[早晚安] 已发送，但写入记忆失败：${error.message}`)}
      }
      log(`群 ${ctx.groupId} ${kind==='night'?'晚安':'早安'}已确认发送`)
    }catch(error){entry.status='uncertain';save();logger?.warn?.(`[早晚安] 群 ${ctx.groupId} 发送结果不明，不重复发送：${error.message}`)}
    if(sendGapMs>0)await pause(sendGapMs)
  }
  async function tick({morningCatchup=false}={}){
    if(busy||stopped)return
    busy=true
    const at=now(),online=Boolean(onebot.status?.().online),previousAt=lastAt,previousOnline=lastOnline
    const connection=onebot.ws,version=onebot.accountStatusVersion
    const sameConnection=lastConnection===connection&&lastVersion===version
    lastAt=at;lastOnline=online;lastConnection=connection;lastVersion=version
    try{
      if(!config.quietGreetingsEnabled||blocked)return
      activate()
      for(const [key,entry] of Object.entries(state.deliveries))if(at-entry.at>14*DAY)delete state.deliveries[key]
      const list=contexts()
      // 仅比较时段边界并读取固定语库；此路径没有模型调用。
      for(const ctx of list){
        const known=state.groups[ctx.groupId],unchanged=known?.spec===ctx.spec
        const tracked=track(ctx,at),window=greetingWindow(ctx.spec,at)
        if(!online)continue
        if(window.quiet){
          if(morningCatchup)continue
          if(unchanged&&previousOnline&&sameConnection&&previousAt<window.start&&window.start<=at&&at-window.start<60000)
            await send(ctx,'night',{...window,connection,version})
        }else if(morningCatchup||window.ended.end>=Math.max(state.activatedAt,tracked.since))await send(ctx,'morning',window.ended)
      }
    }catch(error){logger?.warn?.(`[早晚安] 本轮停止：${error.message}`)}finally{busy=false}
  }
  async function catchUpMorning(){
    if(busy)throw Error('早晚安调度正在处理，请稍后再试')
    if(stopped||blocked||!config.quietGreetingsEnabled)throw Error('早晚安未启用或状态不可用')
    if(!onebot.status?.().online)throw Error('QQ实际连接尚未确认')
    const before=new Set(Object.keys(state.deliveries))
    await tick({morningCatchup:true})
    const added=Object.entries(state.deliveries).filter(([key,entry])=>!before.has(key)&&entry.kind==='morning').map(([,entry])=>({groupId:entry.groupId,status:entry.status,messageId:entry.messageId??null}))
    return {ok:true,deliveries:added,sent:added.filter(entry=>entry.status==='sent').length,uncertain:added.filter(entry=>entry.status==='uncertain'||entry.status==='pending').length}
  }
  function start(){if(timer)return;stopped=false;timer=setInterval(()=>{void tick()},5000);timer.unref?.();void tick()}
  function stop(){stopped=true;if(timer)clearInterval(timer);timer=null}
  return {tick,start,stop,status,defaultPersona,catchUpMorning}
}
