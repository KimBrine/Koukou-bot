import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLongMemory } from '../src/longMemory.js'
const dir=mkdtempSync(path.join(os.tmpdir(),'memory-retry-'))
let clock=10000000, calls=0, fail=true, reason='temporary failure'
const file=path.join(dir,'memory.json'), logger={warn(){},info(){}}
const llm={async chat(){calls++;if(fail)throw new Error(reason);return '保留事实'}}
const make=(maxChars=1500)=>createLongMemory({file,logger,llm,maxChars,now:()=>clock})
try {
 let m=make();m.addEvicted('g1',[{text:'原始事实'}]);assert.equal(await m.summarize('g1'),false)
 assert.equal(calls,1);assert.equal(m.detail('g1').retry.nextAttemptAt,clock+60000)
 m.addEvicted('g1',Array.from({length:60},()=>({text:'后来到达的消息'})))
 assert.equal(await m.summarize('g1'),false);assert.equal(calls,1)
 m=make();assert.equal(await m.summarize('g1'),false);assert.equal(calls,1,'重启不绕过等待')
 clock+=60000;await m.summarize('g1');assert.equal(calls,2);assert.equal(m.detail('g1').retry.nextAttemptAt,clock+120000)
 assert.equal(m.detail('g1').pending.length,61)
 fail=false;m=make(6000);assert.equal(await m.summarize('g1'),true,'容量调整允许重新整理');assert.equal(calls,3)
 assert.equal(m.detail('g1').pending.length,1);assert.equal(m.detail('g1').retry,null)
 fail=true;reason='data_inspection_failed';await m.summarize('g1');assert.equal(m.detail('g1').retry.nextAttemptAt,clock+1800000)
 m.pause('g1');m.resume('g1');fail=false;assert.equal(await m.summarize('g1'),true,'显式恢复清除等待')
 let reject;const slow=createLongMemory({file,logger,now:()=>clock,llm:{chat:()=>new Promise((_,r)=>{reject=r})}})
 slow.addEvicted('g2',[{text:'旧事实'}]);const task=slow.summarize('g2');slow.setSummary('g2','人工修改');reject(new Error('旧请求失败'));await task
 assert.equal(slow.detail('g2').summary,'人工修改');assert.equal(slow.detail('g2').retry,null)
 console.log('Memory retry checks passed: backoff, persistence, capacity change, manual revision, raw queue preserved.')
} finally {rmSync(dir,{recursive:true,force:true})}
