// 模拟时钟和模型；不连接 QQ，不调用模型服务。
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSummaryDeadline, createSummarySendQueue, summaryConcurrency } from '../src/summaryJobs.js'
import { createDailySummary } from '../src/dailySummary.js'
import { generateCheckedSummary } from '../src/summaryQuality.js'

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
const logger = { info() {}, warn() {}, error() {} }
let passed = 0
async function test(name, fn) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-09T23:00:00+08:00').getTime() })
  try { await fn(); passed++; console.log(`PASS ${name}`) } finally { mock.timers.reset() }
}
await test('默认两群准备，并发数最多三群；单群准备超时可中断等待', async () => {
  assert.equal(summaryConcurrency({}), 2);assert.equal(summaryConcurrency({summaryConcurrency:9}), 3)
  const deadline = createSummaryDeadline({ summaryTaskTimeoutMinutes: 2 })
  const task = deadline.wait(new Promise(() => {}))
  const rejection = assert.rejects(task, err => err.code === 'SUMMARY_DEADLINE')
  mock.timers.tick(120000);await rejection;assert.ok(deadline.signal.aborted);deadline.close()
})
await test('并行生成的报告串行发送，前群失败后仍等待五秒再发送后群', async () => {
  const queue = createSummarySendQueue(), events = [];let release
  const first = queue(async () => { events.push(['start1',Date.now()]);await new Promise(resolve => {release=resolve});throw Error('QQ 拒绝该群') })
  const rejection = assert.rejects(first,/QQ 拒绝该群/)
  const second = queue(async () => {events.push(['start2',Date.now()]);return 'ok'})
  await flush();assert.equal(events.length,1);release();await rejection;await flush()
  mock.timers.tick(4999);await flush();assert.equal(events.length,1)
  mock.timers.tick(1);await flush();assert.equal(await second,'ok');assert.equal(events[1][1]-events[0][1],5000)
})
await test('真实总结流程历史卡住时取消并释放群锁，迟到历史不调用模型或发送', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(),'summary-jobs-'))
  try {
    let release, historyCalls=0, models=0, reports=0
    const onebot = { selfId:'999', async getGroupMsgHistory(){ historyCalls++;return new Promise(resolve=>{release=resolve}) },
      async sendGroup(){return {message_id:1}},async sendGroupForward(){reports++;return {message_id:2}} }
    const config = {dataDir:dir,summaryEnabled:true,summaryGroups:[101],whitelistGroups:new Set(),summaryTaskTimeoutMinutes:2}
    const summary = createDailySummary({config,logger,onebot,llm:{async chat(){models++;throw Error('不应调用')}}})
    const task = summary.runSummary(101);await flush();assert.ok(summary.isRunning(101))
    mock.timers.tick(120000);await flush();await task;assert.equal(summary.isRunning(101),false)
    release({messages:[{message_id:3,message_seq:3,time:1,user_id:123,message:'历史消息'}]});await flush()
    assert.equal(historyCalls,1);assert.equal(models,0);assert.equal(reports,0)
  } finally {
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('summary-jobs-'));rmSync(dir,{recursive:true,force:true})
  }
})
await test('模型迟到完成不再修正或发送，生成中收到的取消信号可核对', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(),'summary-jobs-'))
  try {
    const start = new Date('2026-10-09T00:00:00+08:00').getTime()/1000
    const messages=[{message_id:1,message_seq:1,time:start-1,user_id:123,message:'昨日'},
      {message_id:2,message_seq:2,time:start+72000,user_id:123,message:'今天的消息'}]
    let release, signal, calls=0, reports=0
    const onebot={selfId:'999',async getGroupMsgHistory(){return {messages}},async sendGroup(){return {message_id:1}},
      async sendGroupForward(){reports++;return {message_id:2}}}
    const config={dataDir:dir,summaryEnabled:true,summaryGroups:[101],whitelistGroups:new Set(),summaryTaskTimeoutMinutes:2,summaryMaxMessages:600}
    const summary=createDailySummary({config,logger,onebot,llm:{async chat(p,m,opts){calls++;signal=opts.signal;return new Promise(resolve=>{release=resolve})}}})
    const task=summary.runSummary(101);await flush();mock.timers.tick(700);await flush();assert.equal(calls,1)
    mock.timers.tick(119300);await flush();await task;assert.equal(summary.isRunning(101),false);assert.ok(signal.aborted)
    release('只有一个话题的迟到内容');await flush();assert.equal(calls,1);assert.equal(reports,0)
  } finally {
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('summary-jobs-'));rmSync(dir,{recursive:true,force:true})
  }
})
await test('质量修正与首次生成共用一个时限，不为第二次生成重置预算', async () => {
  const deadline=createSummaryDeadline({summaryTaskTimeoutMinutes:2});let calls=0,release
  const llm={async chat(p,m,opts){calls++;assert.equal(opts.signal,deadline.signal)
    return new Promise(resolve=>{release=resolve})}}
  const task=deadline.wait(generateCheckedSummary({llm,prompt:'p',messages:[],records:[],stats:{people:1},logger,signal:deadline.signal}))
  const rejection=assert.rejects(task,err=>err.code==='SUMMARY_DEADLINE')
  mock.timers.tick(90000);release('不完整正文');await flush();assert.equal(calls,2)
  mock.timers.tick(30000);await flush();await rejection;assert.ok(deadline.signal.aborted)
  release('迟到修正');await flush();assert.equal(calls,2);deadline.close()
})
console.log(`${passed} cases passed`)
