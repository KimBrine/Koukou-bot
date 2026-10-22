import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createStickers} from '../src/stickers.js'
import {createStickerLearner} from '../src/stickerLearn.js'
import {createAdminServer} from '../src/admin/server.js'
const root=mkdtempSync(path.join(os.tmpdir(),'sticker-weight-cap-')),logger={info(){},warn(){}}
const image=i=>'data:image/png;base64,'+Buffer.from('offline-image-'+i).toString('base64')
try{
 const weightedDir=path.join(root,'weighted')
 let w=createStickers({dir:weightedDir})
 const records=[['开心猫猫',[],999],['开心猫猫',[],0],['祝福',['开心猫猫'],0],['开心猫猫头',[],0],['开心猫咪',[],0]].map(([name,keywords,usage],i)=>({id:'id'+i,file:i+'.png',name,keywords,usage}))
 writeFileSync(path.join(weightedDir,'stickers.json'),JSON.stringify(records));w=createStickers({dir:weightedDir})
 assert.deepEqual(w.candidates(['开心猫猫']).map(x=>x.weight),[1.7,1.7,1.5,1.2,1])
 const counts=Array(5).fill(0),n=7100
 for(let i=0;i<n;i++){const [item]=w.choose(['开心猫猫'],{rand:()=>(i+.5)/n});counts[Number(item.id.slice(2))]++}
 assert.deepEqual(counts,[1700,1700,1500,1200,1000],'同分同机会，使用次数不参与；不同分按权重分配')
 assert.equal(new Set(w.choose(['开心猫猫','开心猫猫'],{limit:5,rand:()=>0}).map(x=>x.id)).size,5)
 assert.deepEqual(w.choose(['完全无关的请求']),[])
 const dir=path.join(root,'cap');let lib=createStickers({dir})
 for(let i=0;i<60;i++)lib.add({name:'重复名',dataUrl:image(i)})
 assert.equal(lib.count(),60);assert.equal(lib.learningAllowed(),false)
 assert.throws(()=>lib.add({name:'超额',dataUrl:image(61)}),/60/)
 assert.equal(lib.add({dataUrl:image(0)}).duplicated,true,'满库仍可识别同一文件')
 lib=createStickers({dir});assert.equal(lib.learningAllowed(),false,'重启保持关闭')
 const envFile=path.join(root,'.env');writeFileSync(envFile,'STICKER_LEARN_ENABLED=0\n')
 const config={rootDir:root,dataDir:root,envFile,whitelistGroups:new Set(),stickerLearnEnabled:true,stickerLearnGroups:new Set([1]),stickerLearnPerHour:6}
 const admin=createAdminServer({config,stickers:lib})
 for(const [action,payload]of[['set-config',{key:'STICKER_LEARN_ENABLED',value:'1'}],['set-config-batch',{patch:{STICKER_LEARN_ENABLED:'1'}}]])await assert.rejects(admin.actions[action](payload),/60/)
 assert.equal(readFileSync(envFile,'utf8'),'STICKER_LEARN_ENABLED=0\n','拒绝启用之前不改配置')
 lib.remove(lib.list()[0].id);assert.equal(lib.learningAllowed(),false,'人工清理不自动重开')
 lib.resumeLearning();assert.equal(lib.learningAllowed(),true)
 let resolveFilter,entered,tagCalls=0;const started=new Promise(r=>{entered=r})
 const learner=createStickerLearner({config,logger,stickers:lib,imageCache:{load:async()=>({part:{image_url:{url:image('candidate')}}})},filterLLM:{describeImages:async()=>{entered();return new Promise(r=>{resolveFilter=r})}},tagLLM:{describeImages:async()=>{tagCalls++;return '{"isSticker":true,"name":"学习"}'}}})
 const task=learner.learnFromMessage({chatKey:'g1',images:[{}]});await started
 lib.add({name:'人工占满最后一格',dataUrl:image('manual')});resolveFilter('{"isSticker":true}');await task
 assert.equal(tagCalls,0,'在途初筛后容量变化，停止后续付费打标');assert.equal(lib.count(),60)
 await learner.learnFromMessage({chatKey:'g1',images:[{}]});assert.equal(learner.stats().used,1,'满库不占新学习名额')
 const other=createStickers({dir:path.join(root,'other-persona')});assert.equal(other.learningAllowed(),true,'满库锁不影响其他人格')
 console.log('Weighted/cap checks passed: duplicate fairness, weighted distribution, no replacement, 60 limit, persisted lock, API rejection, in-flight cancellation, persona isolation.')
}finally{rmSync(root,{recursive:true,force:true})}
