import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import {createSummaryProgress} from '../src/summaryProgress.js'
import {createDailySummary} from '../src/dailySummary.js'
import {createAdminServer} from '../src/admin/server.js'
const root=mkdtempSync(path.join(os.tmpdir(),'summary-progress-')),logger={info(){},warn(){},error(){},debug(){}}
try{
 const file=path.join(root,'progress.json'),p=createSummaryProgress({file,logger})
 assert.equal(p.get(101).status,'idle')
 const job=p.start(101);assert.equal(p.start(101).jobId,job.jobId)
 p.update(101,job.jobId,{stage:'model',message:'正在生成'})
 assert.equal(p.acknowledge(101,job.jobId),false,'运行中不能清除')
 p.update(101,job.jobId,{status:'success',message:'已发送'})
 const reloaded=createSummaryProgress({file,logger});assert.equal(reloaded.get(101).status,'success')
 assert.equal(reloaded.acknowledge(101,'old-job'),false)
 assert.equal(reloaded.acknowledge(101,job.jobId),true)
 const next=reloaded.start(101);assert.notEqual(next.jobId,job.jobId)
 assert.equal(reloaded.acknowledge(101,job.jobId),false,'旧页面不能清除新任务')
 assert.equal(createSummaryProgress({file,logger}).get(101).stage,'interrupted')
 assert.equal(createSummaryProgress({file,logger}).get(101).status,'failed')
 const snapshot=reloaded.get(101);snapshot.status='success';assert.equal(reloaded.get(101).status,'generating')

 const G=200000002,now=Math.floor(Date.now()/1000),day=new Date();day.setHours(0,0,0,0)
 const rows=[{message_id:1,message_seq:1,time:Math.floor(day/1000)-1,user_id:123,message:'旧消息'},
 {message_id:2,message_seq:2,time:now-1,user_id:123,sender:{nickname:'群友甲'},message:'当天聊天'}]
 let releaseHistory,releaseSend,reads=0,sends=0
 const onebot={selfId:'999',async getGroupMsgHistory(){reads++;return reads===1?new Promise(r=>releaseHistory=r):{messages:rows}},async sendGroup(){},async sendGroupForward(){sends++;return new Promise(r=>releaseSend=r)}}
 const config={rootDir:root,dataDir:root,summaryEnabled:true,summaryGroups:[G],whitelistGroups:new Set([G]),summaryMaxMessages:600,summaryMaxBlocks:20,summarySendMode:'forward',summaryUserRows:20,botName:'测试助手'}
 const daily=createDailySummary({config,logger,onebot,llm:{async chat(){throw Error('统计版不调用模型')}}})
 const task=daily.runSummary(G,{statsOnly:true});assert.equal(daily.progress.get(G).stage,'history')
 const current=daily.progress.get(G).jobId;await daily.runSummary(String(G));assert.equal(reads,1);assert.equal(daily.progress.get(G).jobId,current)
 releaseHistory({messages:rows});for(let i=0;i<100&&!releaseSend;i++)await new Promise(r=>setTimeout(r,20))
 assert.equal(daily.progress.get(G).stage,'sending');assert.equal(daily.progress.get(G).status,'generating');assert.equal(sends,1)
 releaseSend({message_id:99});await task
 assert.equal(daily.progress.get(G).resultKind,'statistics');assert.equal(daily.progress.get(G).status,'success');assert.match(daily.progress.get(G).message,/统计版/)
 assert.equal(daily.isRunning(G),false)
 // 夜间完成的报告在发送队列外等待，醒来继续，不重复生成。
 let awake=false,wake,sleepSends=0
 const sleeping=createDailySummary({config:{...config,dataDir:path.join(root,'sleep')},logger,
   onebot:{...onebot,async getGroupMsgHistory(){return {messages:rows}},async sendGroupForward(){sleepSends++;return {message_id:123}}},
   llm:{},canPublish:()=>awake,publicationPause:()=>new Promise(resolve=>wake=resolve)})
 const overnight=sleeping.runSummary(G,{statsOnly:true})
 for(let i=0;i<100&&!wake;i++)await new Promise(r=>setTimeout(r,10))
 assert.equal(typeof wake,'function');assert.equal(sleepSends,0)
 assert.match(sleeping.progress.get(G).message,/寂静时段结束后/)
 awake=true;wake();await overnight
 assert.equal(sleepSends,1);assert.equal(sleeping.progress.get(G).status,'success')
 const api=createAdminServer({config,logger,onebot,memory:{},dailySummary:daily})
 assert.equal((await api.actions['summary-ack']({groupId:G,jobId:current})).acknowledged,true)
 assert.equal(daily.progress.get(G).status,'idle')
 await assert.rejects(()=>api.actions.summary({groupId:'bad'}),/群号无效/)

 const failure=createDailySummary({config:{...config,dataDir:path.join(root,'missing')},logger,onebot:{...onebot,async getGroupMsgHistory(){throw Error('读取异常')}},llm:{}})
 await failure.runSummary(G);assert.equal(failure.progress.get(G).status,'failed');assert.match(failure.progress.get(G).message,/未确认完整/)
 assert.equal(failure.isRunning(G),false)

 const app=readFileSync(new URL('../src/admin/app.js',import.meta.url),'utf8')
 const context=vm.createContext({location:{hash:'#chats'},window:{},document:{getElementById(){return null}}})
 vm.runInContext(app.slice(0,app.search(/\r?\nrenderNav\(\)\r?\nload\(\)/)),context)
 const html=(status,message='阶段说明')=>vm.runInContext(`state={summaryProgress:[{groupId:101,status:${JSON.stringify(status)},jobId:'j1',message:${JSON.stringify(message)}}]};summaryControlsHTML(101)`,context)
 assert.match(html('idle'),/空闲中/);assert.doesNotMatch(html('idle'),/data-summary-ack/)
 assert.match(html('generating'),/disabled/);assert.match(html('generating'),/生成中/)
 assert.match(html('success'),/生成成功/);assert.match(html('success'),/data-summary-ack/)
 vm.runInContext("state={summaryProgress:[{groupId:101,status:'success',resultKind:'statistics'}]}",context);assert.match(vm.runInContext('summaryControlsHTML(101)',context),/仅统计版/);
 assert.match(html('failed'),/生成失败/);assert.match(html('failed'),/已阅读并关闭/)
 assert.doesNotMatch(html('failed','<img src=x>'),/<img/)
 console.log('群总结进度通过：独立任务、发送后成功、重复启动保护、失败、持久化、重启中断、按任务确认及前端状态。无真实QQ或模型调用。')
}finally{assert.equal(path.dirname(root),os.tmpdir());rmSync(root,{recursive:true,force:true})}
