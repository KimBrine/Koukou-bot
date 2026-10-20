import { createChatPromptBuilder } from '../src/chatPrompt.js'
import { isQuestionMode } from '../src/questionMode.js'
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
function setup({config={},getMsg,forwards={},chat,chatSettings,rateLimiter,visionLLM,imageCache,webSearch,chatRaw,stickers,summaryGroups=[group]}={}) {
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
  const bot=createBot({config:cfg,logger,onebot,memory,chatSettings,rateLimiter,visionLLM,imageCache,webSearch,stickers,rand:()=>0.5,
    buildSystemPrompt:createChatPromptBuilder({config:{persona:'群聊人设'},longMemory:{}}),llm:{async chat(...args){requests.push(args);return chat?chat(...args):'明白了，继续聊呀'},async chatRaw(messages,tools){requests.push([messages[0].content,messages.slice(1)]);return chatRaw?chatRaw(messages,tools):{content:'这是本轮回答',toolCalls:null}}},
    dailySummary:{capture(evt){captured.push(evt.message_id)},summaryGroups:()=>summaryGroups}})
  function event(message,extra={}){time=Math.max(time,Math.floor(Date.now()/1000)*1000);const evt={post_type:'message',message_type:'group',user_id:user,group_id:group,
    message_id:++ids,time:time/1000,sender:{nickname:'群友甲'},message:typeof message==='string'?[text(message)]:message,...extra}
    evt.messageContext=timeline.receive(evt);return evt}
  return {bot,memory,cfg,timeline,onebot,sent,requests,lookups,forwardReads,captured,event,advance:ms=>{time+=ms},time:()=>time}
}
const lastUser=t=>t.requests.at(-1)[1].at(-1).content
const shape=t=>t.requests.at(-1)[0].match(/【本次回复的形态要求[^]*?(?=\n\n【|$)/)?.[0]
try {
  await test('随机发表情为0仍可由模型选库内图，标签不泄漏、纯文字装饰限制不挡图',async()=>{
    const item={id:'sticker',name:'猫猫问号'}
    const stickers={count:()=>1,summary:()=>item.name,find:q=>q===item.name?item:null,pick:()=>item,dataUrlOf:()=> 'base64://eA=='}
    const t=setup({stickers,config:{stickersEnabled:true,stickerMaxPerReply:1,stickerAutoRate:0},chat:()=> '[贴纸: 猫猫问号]'})
    await t.bot.handleMessage(t.event([at(),text('啊？')]))
    assert.equal(t.sent.length,1);assert.equal(t.sent[0][0].type,'image');assert.equal(t.sent[0][0].data.sub_type,1)
    const prompt=t.requests[0][0]
    assert.match(prompt,/明确例外/);assert.ok(prompt.lastIndexOf('【表情包发送规则】')>prompt.lastIndexOf('【本条回复的装饰】'))
    assert.equal(t.memory.get('g'+group).at(-1).content,'[表情包]')
    const n=setup({stickers,config:{stickersEnabled:true,stickerMaxPerReply:1,stickerAutoRate:0},chat:()=> '正常聊呀'})
    await n.bot.handleMessage(n.event([at(),text('你好')]))
    assert.equal(n.sent.length,1);assert.equal(typeof n.sent[0],'string','不选图且随机率0时不强行补图')
  })
  await test('/Q仅私聊或当前外层@触发，标记有边界且不改变全局模式', async()=>{
    assert.equal(isQuestionMode('/Q 推导',{isPrivate:true}),true)
    assert.equal(isQuestionMode('请 /q解题',{atBot:true}),true)
    assert.equal(isQuestionMode('/Q1+1等于几',{isPrivate:true}),true)
    assert.equal(isQuestionMode('帮我/Q（看这题）',{atBot:true}),true)
    assert.equal(isQuestionMode('/Q 推导',{atBot:false}),false)
    for(const text of ['/Query','https://example.com/Q','abc/Q']) assert.equal(isQuestionMode(text,{isPrivate:true}),false)
    const solution='1. 建立方程\n\n令 f(x) = (x + 1) * (x - 1)，得到 x² - 1。'.repeat(8)+'\n```python\ndef solve(x):\n    return (x + 1) * (x - 1)\n```'
    const t=setup({config:{replyLongMode:true,replyTimingEnabled:true},chat:async()=>{await new Promise(r=>setTimeout(r,5));return solution}})
    await t.bot.handleMessage(t.event([at(),text('/Q 请讲过程')]))
    assert.match(t.requests[0][0],/本轮 \/Q 解题模式/)
    assert.equal(t.sent.length,1)
    assert.ok(t.sent[0].includes(solution),'完整保留公式、代码、分段和长正文')
    assert.match(t.sent[0],/想了 [\d.]+ 秒/)
    await t.bot.handleMessage(t.event([at(),text('好呀')]))
    assert.doesNotMatch(t.requests.at(-1)[0],/【本轮 \/Q 解题模式】/)
    assert.doesNotMatch(t.sent.at(-1),/想了 [\d.]+ 秒/)
    assert.ok(t.sent.at(-1).length<solution.length,'下一轮恢复聊天长度，即使有旧全局开关')
    assert.equal(t.cfg.replyLongMode,true,'请求不修改共享配置')
    const p=setup({config:{replyTimingEnabled:false},chat:()=>solution})
    await p.bot.handleMessage(p.event('/Q 推导',{message_type:'private'}))
    assert.ok(p.sent[0].includes(solution));assert.doesNotMatch(p.sent[0],/想了 [\d.]+ 秒/)
  })
  await test('/Q不由群里引用或转发的旧标记触发，解题图片读完整题干',async()=>{
    const q=setup({config:{proactiveRate:1},getMsg:()=>({message_id:'99',group_id:group,user_id:selfId,message:[text('/Q 旧问题')]}),chat:()=> '收到'})
    await q.bot.handleMessage(q.event([quote('99'),text('/Q 问题')]))
    assert.doesNotMatch(q.requests[0][0],/【本轮 \/Q 解题模式】/)
    let visionPrompt='', options, desc='题目全文与图表条件'.repeat(40)
    const t=setup({visionLLM:{async describeImages(prompt,ask,parts,opts){visionPrompt=prompt;options=opts;return desc}},
      imageCache:{async load(){return {part:{type:'image_url',image_url:{url:'data:image/png;base64,eA=='}},hash:'test'}},async describe(hashes,scope,read){assert.match(scope,/question-v1/);return read()}},chat:()=> '1. 解法\n```python\nprint(1)\n```'})
    await t.bot.handleMessage(t.event([at(),text('/Q 解这道题'),{type:'image',data:{file:'x'}}]))
    assert.match(visionPrompt,/完整转录/);assert.equal(options.maxTokens,0)
    assert.ok(t.requests[0][1].at(-1).content.includes(desc),'题干不压成160字图片短描述')
    assert.match(t.sent[0],/```python/)
    assert.equal(t.requests.length,1,'解题正文不被图片分析报告拦截器重试')
  })
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
  await test('引用自己的前轮建议后，旁人问句保留背景但不替换当前回复对象',async()=>{
    const t=setup({chat:()=> '先看预算，别急着买呀'})
    await t.bot.handleMessage(t.event([at(),text('我想买画板')]))
    const ownReceipt=ids
    await t.bot.handleMessage(t.event('谁来组队',{user_id:user+1,sender:{nickname:'群友乙'}}))
    const current=t.event([quote(ownReceipt),at(),text('可是好贵')]);await t.bot.handleMessage(current)
    const [prompt,messages]=t.requests.at(-1),last=messages.at(-1).content
    const focus=JSON.parse(last.match(/本轮定位数据 ([\s\S]*)】$/)[1])
    assert.equal(focus.messageId,String(current.message_id));assert.equal(focus.userId,String(user));assert.equal(focus.text,'可是好贵')
    assert.equal(focus.quote.author,'你此前的回复');assert.match(focus.quote.text,/预算/)
    assert.ok(focus.precedingDialogueWithThisSender.some(m=>m.text.includes('画板')))
    assert.ok(focus.precedingDialogueWithThisSender.every(m=>!m.text.includes('组队')))
    assert.ok(messages.slice(0,-1).some(m=>m.content.includes('谁来组队')));assert.match(prompt,/不能替换本轮回复目标/)
    assert.equal(t.memory.get(`g${group}`).at(-1).replyToMessageId,String(current.message_id))
    assert.ok(t.memory.get(`g${group}`).every(m=>!m.content.includes('本轮定位数据')))
  })
  await test('引用读取期间后到插话不混入本轮快照，但原话仍进入群记忆',async()=>{
    let release;const t=setup({getMsg:()=>new Promise(resolve=>{release=resolve})})
    const current=t.event([quote(42),at(),text('接着说这个')]);const pending=t.bot.handleMessage(current)
    await new Promise(setImmediate);assert.ok(release)
    await t.bot.handleMessage(t.event('后到的另一件事',{user_id:user+1,sender:{nickname:'群友乙'}}))
    release({message_id:42,group_id:group,user_id:selfId,message:[text('原先的话题')]});await pending
    assert.equal(t.requests.length,1);assert.doesNotMatch(JSON.stringify(t.requests[0]),/后到的另一件事/)
    assert.ok(t.memory.get(`g${group}`).some(m=>m.content.includes('后到的另一件事')))
    assert.match(lastUser(t),/接着说这个/);assert.match(lastUser(t),/原先的话题/)
  })
  await test('开启搜索的直接回复与识图后的回复都保留同一目标定位',async()=>{
    const a=setup({webSearch:async()=>{throw Error('不应搜索')},chatRaw:()=>({content:'这是针对当前发言的回答',toolCalls:null})})
    const first=a.event([at(),text('当前这句')]);await a.bot.handleMessage(first)
    assert.match(lastUser(a),/本轮定位数据/);assert.match(lastUser(a),new RegExp(`messageId.*${first.message_id}`))
    const b=setup({visionLLM:{async describeImages(){return '一张画板的照片'}},imageCache:{async load(){return {part:{type:'image_url',image_url:{url:'data:image/png;base64,dummy'}}}},async describe(hashes,scope,read){return read()}}})
    const second=b.event([at(),text('这张图呢'),{type:'image',data:{file:'fixture'}}]);await b.bot.handleMessage(second)
    assert.equal(b.sent.length,1);assert.match(lastUser(b),/本轮定位数据/);assert.match(lastUser(b),new RegExp(`messageId.*${second.message_id}`))
    assert.match(b.requests.at(-1)[0],/画板/)
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
    assert.match(prompt,/结合群内前文、明确引用和已知用语含义判断/)
    assert.match(prompt,/不为某个表情预设圈内含义/)
    assert.match(prompt,/尊重不同身份、治疗与生活选择/)
    assert.match(prompt,/日常玩笑不自动附加风险教育、免责声明或劝阻/)
    assert.match(prompt,/现实用药问题不擅自决定具体药物、剂量、次数或停换方案/)
    assert.match(prompt,/区分普通食物、现实事件和玩笑/)
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
