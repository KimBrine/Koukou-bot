// 模拟 OneBot、模型与图片；不连接 QQ、不下载图片、不调用付费模型。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createBot } from '../src/bot.js'
import { MemoryStore, modelHistory } from '../src/memory.js'
import { MessageTimeline } from '../src/messageFreshness.js'
import { backlogLength } from '../src/replyShape.js'
import { createQuotedMessageResolver } from '../src/quotedMessage.js'
import { computeSummaryStats } from '../src/summaryStats.js'
import { profileSummaryContent } from '../src/summaryContent.js'

const group=200000002,selfId='200000010',user=200000011
const logger={info(){},warn(){},debug(){},error(){}}
const text=t=>({type:'text',data:{text:t}}), at=()=>({type:'at',data:{qq:selfId}})
const quote=id=>({type:'reply',data:{id:String(id)}}),forward=id=>({type:'forward',data:{id}})
const node=(name, content)=>({sender:{nickname:name,user_id:200000020},time:1,message:content})
const dir=mkdtempSync(path.join(os.tmpdir(),'koukou-context-')),stores=[]
let files=0,ids=1000,passed=0
async function test(name,fn){await fn();passed++;console.log(`PASS ${name}`)}
function setup({config={},getMsg,forwards={},chat,chatSettings,rateLimiter,visionLLM,summaryGroups=[group]}={}) {
  let time=Math.floor(Date.now()/1000)*1000
  const timeline=new MessageTimeline({now:()=>time});timeline.begin()
  const memory=new MemoryStore({file:path.join(dir,`${++files}.json`),limit:99,logger});stores.push(memory)
  const sent=[],requests=[],lookups=[],forwardReads=[],captured=[]
  const onebot={selfId,messageTimeline:timeline,
    async sendGroup(g,t){sent.push(t);return {message_id:++ids}},async sendPrivate(u,t){sent.push(t);return {message_id:++ids}},
    async getMsg(id){lookups.push(id);return getMsg?getMsg(id):{message_id:id,group_id:group,user_id:selfId,sender:{nickname:'测试机器人',user_id:selfId},message:[text('之前的答案')]}},
    async getForwardMsg(id){forwardReads.push(id);if(forwards[id] instanceof Error)throw forwards[id];return {messages:forwards[id]??[]}},
  }
  const cfg={whitelistGroups:new Set([group]),mutedGroups:new Set(),proactiveRate:0,proactiveCooldownMs:0,
    quietHours:'',contextRememberAll:true,autoPlusOneEnabled:false,replyMaxLines:3,replyLineMaxChars:40,
    humanDelayMinMs:0,humanDelayMaxMs:0,lineGapMinMs:0,lineGapMaxMs:0,emojiKeepRate:0,replyLengthMatch:true,
    visionMaxImages:2,rateLimitAtPerHour:45,...config}
  const bot=createBot({config:cfg,logger,onebot,memory,chatSettings,rateLimiter,visionLLM,rand:()=>0.5,
    buildSystemPrompt:()=> '群聊人设',llm:{async chat(...args){requests.push(args);return chat?chat(...args):'明白了，继续聊呀'}},
    dailySummary:{capture(evt){captured.push(evt.message_id)},summaryGroups:()=>summaryGroups}})
  function event(message,extra={}){const evt={post_type:'message',message_type:'group',user_id:user,group_id:group,
    message_id:++ids,time:time/1000,sender:{nickname:'群友甲'},message:typeof message==='string'?[text(message)]:message,...extra}
    evt.messageContext=timeline.receive(evt);return evt}
  return {bot,memory,cfg,timeline,onebot,sent,requests,lookups,forwardReads,captured,event,advance:ms=>{time+=ms},time:()=>time}
}
const lastUser=t=>t.requests.at(-1)[1].at(-1).content
const shape=t=>t.requests.at(-1)[0].match(/【本次回复的形态要求[^]*?(?=\n\n【|$)/)?.[0]
try {
  await test('连续短句和动作保留完整问答，多人明确引用可以接入前文',async()=>{
    const replies=['也分你一块饼干呀','张嘴，啊——','咬一小口，慢慢吃呀']
    const t=setup({chat:()=>replies.shift()})
    await t.bot.handleMessage(t.event([at(),text('我也想吃饼干')]))
    await t.bot.handleMessage(t.event([quote(ids),text('来')],{user_id:user+1,sender:{nickname:'群友乙'}}))
    await t.bot.handleMessage(t.event([quote(ids),text('（咬一口）')],{user_id:user+1,sender:{nickname:'群友乙'}}))
    assert.equal(t.requests.length,3);assert.equal(t.sent.length,3)
    const [prompt,messages]=t.requests.at(-1)
    assert.deepEqual(messages.map(m=>m.role),['user','assistant','user','assistant','user'])
    assert.match(messages[0].content,/我也想吃饼干/)
    assert.match(messages[0].content,/第2条历史消息是机器人回复.*群友甲/)
    assert.equal(messages[1].content,'也分你一块饼干呀')
    assert.match(messages[1].content,/也分你一块饼干呀/)
    assert.match(messages[2].content,/群友乙.*引用.*也分你一块饼干呀.*来/)
    assert.match(messages[0].content,/第4条历史消息是机器人回复.*群友乙/)
    assert.equal(messages[3].content,'张嘴，啊——')
    assert.match(messages[3].content,/张嘴，啊——/)
    assert.match(messages.at(-1).content,/引用.*张嘴，啊——.*咬一口/)
    assert.match(prompt,new RegExp(`当前发言者的用户标识为 ${user+1}`))
    assert.match(prompt,/短句、代词、省略和括号动作/)
    assert.match(prompt,/沿用已经建立的对象、动作和情境/)
    assert.ok(messages.every(m=>Object.keys(m).sort().join(',')==='content,role'))
    assert.equal(t.memory.get(`g${group}`).at(-1).content,'咬一小口，慢慢吃呀')
    assert.equal(t.memory.get(`g${group}`).at(-1).replyToUserId,String(user+1))
  })
  await test('没有引用的连续@也携带前轮；另一位群友插话不会抹掉回复对象',async()=>{
    const t=setup({chat:()=> '刚才说周末一起去呀'})
    const first=t.event([at(),text('周末去公园吗')]);await t.bot.handleMessage(first)
    await t.bot.handleMessage(t.event('我要去图书馆',{user_id:user+1,sender:{nickname:'群友乙'}}))
    await t.bot.handleMessage(t.event([at(),text('那几点')]))
    const messages=t.requests.at(-1)[1]
    assert.match(messages[0].content,/周末去公园吗/)
    assert.match(messages[0].content,new RegExp(`第2条历史消息是机器人回复.*群友甲.*${user}`))
    assert.equal(messages[1].content,'刚才说周末一起去呀')
    assert.match(messages[2].content,/群友乙.*我要去图书馆/)
    assert.match(messages.at(-1).content,/那几点/)
    assert.equal(t.memory.get(`g${group}`)[1].replyToMessageId,String(first.message_id))
    assert.match(t.requests.at(-1)[0],/不能把其他人的经历或承诺算到当前发言者身上/)
  })
  await test('发言和回复归属重启后保留，旧记录不猜对象且不改变字数预算',async()=>{
    const t=setup();await t.bot.handleMessage(t.event([at(),text('你好呀')]))
    const before=backlogLength(t.memory.get(`g${group}`))
    t.memory.push(`g${group}`,'assistant','旧版回复')
    t.memory.flush()
    const restored=new MemoryStore({file:t.memory.file,limit:99,logger});restored.load()
    const history=restored.get(`g${group}`)
    assert.equal(history[0].userId,String(user));assert.equal(history[0].senderName,'群友甲')
    assert.equal(history[1].replyToUserId,String(user));assert.equal(history[1].replyToName,'群友甲')
    assert.equal(backlogLength(history.slice(0,2)),before)
    const messages=modelHistory(history)
    assert.match(messages[0].content,/第2条历史消息是机器人回复.*群友甲/)
    assert.equal(messages[1].content,history[1].content)
    assert.equal(messages[2].content,'旧版回复')
    assert.ok(messages.every(m=>Object.keys(m).sort().join(',')==='content,role'))
    assert.ok(!history[1].content.includes('此前回复对象'))
    t.memory.push('g2','assistant','有界元数据',{replyToName:'甲\n'.repeat(100),replyToUserId:{bad:true}})
    t.memory.flush();restored.load()
    const bounded=restored.get('g2')[0]
    assert.ok(bounded.replyToName.length<=80);assert.ok(!bounded.replyToName.includes('\n'))
    assert.equal(bounded.replyToUserId,undefined)
  })
  await test('独立定时目标不剥夺其他白名单群的日常记忆',async()=>{
    const t=setup({summaryGroups:[group+1]})
    await t.bot.handleMessage(t.event('周末想去看花'))
    assert.equal(t.requests.length,0)
    assert.equal(t.memory.get(`g${group}`).length,1)
    await t.bot.handleMessage(t.event([at(),text('你觉得呢')]))
    assert.match(t.requests[0][1][0].content,/周末想去看花/)
  })
  await test('现实分寸规则对群聊与私聊生效，不由可爱人格覆盖或扩大回复预算',async()=>{
    for(const message_type of ['group','private']){
      const t=setup();await t.bot.handleMessage(t.event([at(),text('我有点怕疼')],{message_type}))
      const prompt=t.requests[0][0]
      assert.ok(prompt.indexOf('【对话衔接与分寸')>prompt.indexOf('群聊人设'))
      assert.match(prompt,/避免毫无依据地把数量、剂量或动作强度突然放大许多倍/)
      assert.match(prompt,/明确表达现实担心、拒绝或不适时，再认真回应/)
      assert.match(prompt,/自己上一句夸张了就自然纠正/)
      assert.match(prompt,/【本次回复的形态要求/)
    }
  })
  await test('隐语按上下文区分激素药物、食物和玩笑，不按单个表情决定用药含义',async()=>{
    const t=setup()
    await t.bot.handleMessage(t.event('这里的符号说的是激素药物，不是零食'))
    await t.bot.handleMessage(t.event([at(),text('那这个🍥呢')]))
    const [prompt,messages]=t.requests[0]
    assert.match(messages[0].content,/激素药物，不是零食/)
    assert.match(prompt,/可能代指激素或其他药物/)
    assert.match(prompt,/结合群内前文、明确引用和已知用语含义判断/)
    assert.match(prompt,/不能仅凭一个表情就断定对方在用药/)
    assert.match(prompt,/已明确的药物隐语保留原意/)
    assert.match(prompt,/明确在玩梗时可以适度调侃、撒娇和轻度夸张/)
    assert.match(prompt,/不因提到激素或药物就拒绝接梗、劝停或说教/)
    assert.match(prompt,/不把这类用药本身视为负面或不正当/)
    assert.match(prompt,/日常玩笑不自动附加风险教育、免责声明或劝阻/)
    assert.match(prompt,/现实用药问题不擅自决定具体药物、剂量、次数或停换方案/)
    assert.match(prompt,/对话明确在说普通食物时/)
  })
  await test('主动概率为零、没有@、不在白名单，引用机器人消息仍直接回复',async()=>{
    const t=setup({config:{whitelistGroups:new Set()}})
    await t.bot.handleMessage(t.event([quote(42),text('接着说呢')]))
    assert.equal(t.requests.length,1);assert.equal(t.sent.length,1);assert.deepEqual(t.lookups,['42'])
    assert.match(lastUser(t),/之前的答案/);assert.match(lastUser(t),/接着说呢/)
  })
  await test('引用其他群友、未知作者或其他群的消息，不伪装为直接回复',async()=>{
    for(const result of [{user_id:user},{sender:{}},{user_id:selfId,group_id:group+1}]){
      const t=setup({getMsg:id=>({message_id:id,message:[text('其他消息')],...result})})
      await t.bot.handleMessage(t.event([quote(42),text('接着说呢')]))
      assert.equal(t.requests.length,0);assert.equal(t.sent.length,0)
    }
  })
  await test('CQ格式引用无需@，只有引用段也能回应机器人',async()=>{
    for(const message of ['[CQ:reply,id=42]继续',[quote(42)]]){
      const t=setup();await t.bot.handleMessage(t.event(message,{message}));assert.equal(t.sent.length,1)
    }
  })
  await test('引用和@同时存在只调用一次模型，取回引用也只查询一次',async()=>{
    const t=setup();await t.bot.handleMessage(t.event([quote(42),at(),text('继续')]))
    assert.equal(t.requests.length,1);assert.equal(t.sent.length,1);assert.equal(t.lookups.length,1)
  })
  await test('已收到的机器人消息优先复用；接口不可用时仍能识别引用',async()=>{
    const t=setup({getMsg:()=>{throw Error('不可用')}})
    const own=t.event('机器人原话',{user_id:Number(selfId),sender:{nickname:'测试机器人'}})
    await t.bot.handleMessage(own)
    await t.bot.handleMessage(t.event([quote(own.message_id),text('继续')]))
    assert.equal(t.lookups.length,0);assert.equal(t.sent.length,1);assert.match(lastUser(t),/机器人原话/)
  })
  await test('发送回执进入引用缓存，没有自身消息上报也能识别刚发的答案',async()=>{
    const t=setup({getMsg:()=>{throw Error('不可用')}})
    await t.bot.handleMessage(t.event([at(),text('你好')]))
    const receiptId=ids
    await t.bot.handleMessage(t.event([quote(receiptId),text('继续')]))
    assert.equal(t.sent.length,2);assert.equal(t.lookups.length,0)
  })
  await test('引用仍遵守会话关闭、直接回复关闭、静音及全静音时段',async()=>{
    const cases=[{config:{mutedGroups:new Set([group])}},
      // 结束点不包含在区间内；覆盖到24:00，避免23:59运行时误放行。
      {config:{quietHours:'00:00-24:00'}},
      {chatSettings:{get:()=>({enabled:false}),resolve:()=>({})}},
      {chatSettings:{get:()=>({enabled:true,atReplyEnabled:false}),resolve:()=>({})}}]
    for(const opts of cases){const t=setup(opts);await t.bot.handleMessage(t.event([quote(42),text('继续')]))
      assert.equal(t.requests.length,0);assert.equal(t.sent.length,0)}
  })
  await test('引用使用直接对话的额度，不被主动回复的每小时额度挡住',async()=>{
    const checks=[];const rateLimiter={check(k,n,opts){checks.push(opts);return {allowed:opts?.perHourLimit===45}},record(){}}
    const t=setup({rateLimiter});await t.bot.handleMessage(t.event([quote(42),text('继续')]))
    assert.equal(t.sent.length,1);assert.ok(checks.every(o=>o.perHourLimit===45))
  })
  await test('群内新消息不会取消正在生成的直接引用回复，断线仍取消',async()=>{
    for(const disconnect of [false,true]){
      let release;const t=setup({chat:()=>new Promise(resolve=>{release=resolve})})
      const task=t.bot.handleMessage(t.event([quote(42),text('继续')]))
      await new Promise(setImmediate);assert.ok(release)
      if(disconnect){t.timeline.end();t.advance(1000);t.timeline.begin()}
      else await t.bot.handleMessage(t.event('别人插话'))
      release('这是直接回复');await task;assert.equal(t.sent.length,disconnect?0:1)
    }
  })
  await test('登录补读的旧引用不查询目标、不调用模型、不补答',async()=>{
    const t=setup();await t.bot.handleMessage(t.event([quote(42),text('旧问题')],{time:t.time()/1000-3600}))
    assert.equal(t.lookups.length,0);assert.equal(t.requests.length,0);assert.equal(t.sent.length,0)
  })
  await test('合并记录含嵌套与多个节点：外层一次捕获、一次记忆、一次生成',async()=>{
    const t=setup({forwards:{outer:[node('甲',[text('外层内容'),forward('inner')]),node('乙',[text('后续内容')])],inner:[node('丙',[text('嵌套内容')])]}})
    await t.bot.handleMessage(t.event([at(),text('怎么看'),forward('outer')]))
    assert.equal(t.requests.length,1);assert.equal(t.sent.length,1);assert.equal(t.captured.length,1)
    assert.equal(t.memory.get(`g${group}`).filter(m=>m.role==='user').length,1)
    assert.match(lastUser(t),/外层内容/);assert.match(lastUser(t),/嵌套内容/);assert.match(lastUser(t),/后续内容/)
    assert.deepEqual(t.forwardReads,['outer','inner'])
  })
  await test('纯卡片不再丢掉；内层@、引用和指令不触发额外回复或命令',async()=>{
    const t=setup({forwards:{outer:[node('甲',[at(),quote(42),text('/群总结')])]}})
    await t.bot.handleMessage(t.event([forward('outer')]))
    assert.equal(t.requests.length,0);assert.equal(t.lookups.length,0)
    assert.equal(t.captured.length,1);assert.equal(t.memory.get(`g${group}`).filter(m=>m.role==='user').length,1)
    assert.match(t.memory.get(`g${group}`)[0].content,/群总结/)
    await t.bot.handleMessage(t.event([at(),forward('outer')]))
    assert.equal(t.requests.length,1);assert.equal(t.sent.length,1)
  })
  await test('引用机器人发出的合并卡片无需@即可递归读取',async()=>{
    const t=setup({getMsg:id=>({message_id:id,user_id:selfId,message:[forward('outer')]}),forwards:{outer:[node('甲',[forward('inner')])],inner:[node('乙',[text('卡片里的线索')])]}})
    await t.bot.handleMessage(t.event([quote(42),text('这个怎么看')]))
    assert.equal(t.requests.length,1);assert.match(lastUser(t),/卡片里的线索/);assert.equal(t.sent.length,1)
  })
  await test('多层嵌套只抽一次主动概率，未命中只阅读；命中只生成一次',async()=>{
    const original=Math.random
    try {
      for(const randomValue of [0.9,0.1]){
        let draws=0;Math.random=()=>randomValue
        const t=setup({config:{proactiveRateFor(){draws++;return 0.2}},forwards:{outer:[node('甲',[forward('inner')]),node('乙',[forward('inner')])],inner:[node('丙',[text('嵌套讨论')])]}})
        await t.bot.handleMessage(t.event([forward('outer')]))
        assert.equal(draws,1);assert.equal(t.requests.length,randomValue<0.2?1:0)
        assert.equal(t.sent.length,randomValue<0.2?1:0);assert.equal(t.captured.length,1)
        assert.equal(t.memory.get(`g${group}`).filter(m=>m.role==='user').length,1)
      }
    } finally {Math.random=original}
  })
  await test('一条与几十条内层消息使用相同回复长度预算和行数',async()=>{
    const outputs=[]
    for(const count of [1,70]){
      const t=setup({forwards:{outer:Array.from({length:count},(_,i)=>node(`群友${i}`,[text('很长的历史聊天内容'.repeat(10))]))}})
      await t.bot.handleMessage(t.event([at(),text('怎么看'),forward('outer')]))
      assert.equal(t.requests.length,1);assert.equal(t.sent.length,1);outputs.push(shape(t))
      assert.equal(t.memory.get(`g${group}`)[0].replyLength,3)
    }
    assert.equal(outputs[0],outputs[1])
  })
  await test('未回复的大卡片也不拉长下一条回复，长度元数据重启后保留且不发给模型',async()=>{
    const t=setup({forwards:{outer:[node('甲',[text('历史资料'.repeat(1000))])]}})
    await t.bot.handleMessage(t.event([text('看看'),forward('outer')]))
    assert.equal(backlogLength(t.memory.get(`g${group}`)),2)
    t.memory.flush();const restored=new MemoryStore({file:t.memory.file,limit:99,logger});restored.load()
    assert.equal(backlogLength(restored.get(`g${group}`)),2)
    assert.ok(modelHistory(restored.get(`g${group}`)).every(m=>Object.keys(m).sort().join(',')==='content,role'))
    await t.bot.handleMessage(t.event([at(),text('怎么看')]))
    assert.equal(t.requests.length,1);assert.match(shape(t),/大约 4 字/)
    assert.match(t.requests[0][1][0].content,/历史资料/)
  })
  await test('读取失败明确说明资料缺失，不伪造聊天原文',async()=>{
    const t=setup({forwards:{outer:Error('读取失败')}})
    await t.bot.handleMessage(t.event([at(),text('怎么看'),forward('outer')]))
    assert.equal(t.requests.length,1);assert.match(lastUser(t),/失败|未能|无法/)
    assert.match(t.requests[0][0],/不能猜测/)
  })
  await test('引用缓存有上限；返回不匹配编号时不认作引用机器人',async()=>{
    let calls=0
    const resolver=createQuotedMessageResolver({onebot:{selfId,async getMsg(id){calls++;return {message_id:'mismatch',user_id:selfId}}},logger,maxEntries:1})
    resolver.remember({message_type:'group',group_id:group,user_id:selfId,message_id:1,message:[text('旧答案')]})
    resolver.remember({message_type:'group',group_id:group,user_id:selfId,message_id:2,message:[text('新答案')]})
    const evt={message_type:'group',group_id:group,user_id:user}
    assert.ok(resolver.isFromBot(await resolver.resolve(evt,2)));assert.equal(await resolver.resolve(evt,1),null);assert.equal(calls,1)
  })
  await test('私聊引用拒绝其他对话人的消息，正常双方发言仍可读取',async()=>{
    for(const [result,valid] of [[{user_id:user+1},false],[{user_id:selfId,target_id:user+1},false],
      [{user_id:selfId,target_id:user},true],[{user_id:user},true]]){
      const resolver=createQuotedMessageResolver({onebot:{selfId,async getMsg(id){return {message_id:id,message_type:'private',message:[text('私聊原文')],...result}}},logger})
      const resolved=await resolver.resolve({message_type:'private',user_id:user},42)
      assert.equal(Boolean(resolved),valid)
    }
  })
  await test('合并卡片只计一条外层消息，占位符不虚增字数或有效话题样本',()=>{
    const records=[{userId:String(user),name:'群友甲',time:1,text:'[合并聊天记录]'}]
    const stats=computeSummaryStats(records)
    assert.equal(stats.total,1);assert.equal(stats.chars,0);assert.equal(profileSummaryContent(records).ordinaryCount,0)
  })
  console.log(`${passed} cases passed`)
}finally {
  for(const memory of stores)if(memory.timer)clearTimeout(memory.timer)
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()))
  assert.ok(path.basename(dir).startsWith('koukou-context-'));rmSync(dir,{recursive:true,force:true})
}
