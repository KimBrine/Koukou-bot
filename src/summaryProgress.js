import {existsSync,readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {writeJsonAtomic} from './stateFile.js'

/** 只记录任务阶段和投递结果，不存聊天正文；终态需按任务编号确认，避免清掉新任务。 */
export function createSummaryProgress({file=null,logger,now=Date.now}={}){
 const items=new Map()
 const save=()=>{if(file)try{writeJsonAtomic(file,Object.fromEntries(items))}catch(e){logger?.warn?.(`群总结进度保存失败：${e.message}`)}}
 try{
  const data=file&&existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{}
  for(const [id,v]of Object.entries(data)){
   if(!/^\d{1,15}$/.test(id)||!v||!['idle','generating','success','failed'].includes(v.status))continue
   items.set(id,{...v,groupId:Number(id),...(v.status==='generating'?{status:'failed',stage:'interrupted',message:'机器人已重启，上次任务已中断；请核对群内是否已发送后再重试。',finishedAt:now()}: {})})
  }
  if([...items.values()].some(v=>v.stage==='interrupted'))save()
 }catch(e){logger?.warn?.(`群总结进度读取失败：${e.message}`)}
 const get=id=>({...items.get(String(id))||{groupId:Number(id),status:'idle',stage:'idle',message:'',jobId:'',updatedAt:0}})
 function start(id,{days=1,scheduled=false}={}){
  const old=get(id);if(old.status==='generating')return old
  const value={groupId:Number(id),jobId:randomUUID(),status:'generating',stage:'history',message:'正在读取聊天记录',days,scheduled,startedAt:now(),updatedAt:now(),finishedAt:0}
  items.set(String(id),value);save();return {...value}
 }
 function update(id,jobId,patch){
  const old=get(id);if(old.jobId!==jobId||old.status!=='generating')return false
  items.set(String(id),{...old,...patch,groupId:old.groupId,jobId,updatedAt:now(),...(['success','failed'].includes(patch.status)?{finishedAt:now()}: {})});save();return true
 }
 function acknowledge(id,jobId){
  const old=get(id);if(old.jobId!==jobId||!['success','failed'].includes(old.status))return false
  items.set(String(id),{...old,status:'idle',stage:'idle',message:'',updatedAt:now()});save();return true
 }
 return {get,all:()=>[...items.values()].map(v=>({...v})),start,update,acknowledge}
}
