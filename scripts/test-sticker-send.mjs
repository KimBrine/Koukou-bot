import assert from 'node:assert/strict'
import {createStickerSendPolicy,userAsksForSticker} from '../src/stickerSend.js'
const event={message_type:'group',group_id:12345,user_id:1},item={id:'x',name:'猫猫'}
const library={count:()=>1,find:q=>q==='猫猫'?item:null,pick:()=>item,random:()=>item}
const config={stickersEnabled:true,stickerAutoRate:.35,stickerMaxPerReply:1,whitelistGroups:new Set([12345])}
let value=0,now=10000
const policy=createStickerSendPolicy({config,stickers:library,rand:()=>value,now:()=>now})
let hits=0
for(let i=0;i<100;i++){value=i/100;if(policy.select(event,{text:'文字',queries:['猫猫']}).items.length)hits++}
assert.equal(hits,35,'模型点名也只按35%配图')
value=0;assert.equal(policy.select(event,{text:' '}).items.length,0)
value=.99;assert.equal(policy.select(event,{text:'给你挑一张',requested:true}).items.length,1)
config.stickerAutoRate=0
assert.equal(policy.select(event,{text:'给你挑一张',requested:true}).items.length,1,'明确索图不受0自动概率限制')
config.stickerAutoRate=.35;value=0
config.stickerSendScope='whitelist';assert.equal(policy.allowed({...event,group_id:2}),false)
config.stickerSendScope='selected';config.stickerSendGroups=new Set([2]);assert.equal(policy.allowed(event),false)
config.stickerSendScope='private';assert.equal(policy.allowed(event),false);assert.equal(policy.allowed({message_type:'private'}),true)
config.stickerSendScope='all';config.stickerCooldownSeconds=60
policy.begin(event);assert.equal(policy.select(event,{text:'文字'}).items.length,0)
now+=60000;assert.equal(policy.select(event,{text:'文字',queries:['猫猫']}).items.length,1)
config.stickerPickMode='model';assert.equal(policy.select(event,{text:'文字'}).items.length,0)
assert.equal(policy.select(event,{text:'给你挑一张',requested:true}).items.length,1,'明确索图即使没点名也选库中图片')
assert.equal(policy.select(event,{text:'文字',queries:['猫猫','猫猫']}).items.length,1)
config.stickerPickMode='random';assert.equal(policy.select(event,{text:'文字'}).items.length,1)
config.stickerPickMode='context'
let fallbackCalls=0
library.pick=()=>{fallbackCalls++;return item};library.random=()=>{fallbackCalls++;return item}
assert.equal(policy.select(event,{text:'认真陪你说话',context:'这个话题让人害怕'}).items.length,0,'语境模式未选图不能随机补位')
assert.equal(policy.select(event,{text:'认真陪你说话',queries:['不存在的表情']}).items.length,0,'模型给出不存在的名称不能换成其他图')
assert.equal(fallbackCalls,0,'普通自动配图不调用历史关键词或随机选图')
assert.equal(policy.select(event,{text:'给你挑一张',requested:true}).items.length,1,'明确索图保留候选兜底')
assert.equal(fallbackCalls,1)
assert.match(policy.select(event,{text:'自然回应',queries:['猫猫']}).source,/模型/)
config.stickersEnabled=false;assert.equal(policy.allowed(event),false)
// 用户明确索图用确定性判断，不依赖模型标记
assert.equal(userAsksForSticker('给我发个表情包'),true)
assert.equal(userAsksForSticker('给我张表情包'),true)
assert.equal(userAsksForSticker('来张贴纸'),true)
assert.equal(userAsksForSticker('发张图看看'),true)
assert.equal(userAsksForSticker('这个图好看'),false)
assert.equal(userAsksForSticker('你在干嘛'),false)
config.stickersEnabled=true
const reqPolicy=createStickerSendPolicy({config:{...config,stickerCooldownSeconds:0},stickers:library,rand:()=>0.99,now:()=>200000})
assert.equal(reqPolicy.select(event,{text:'文字',queries:['不存在'],requested:userAsksForSticker('给我发个表情包')}).items.length,1,'索图即使没候选也会兜底选一张')
console.log('配图策略通过：文字前提、35%统一门槛、范围、冷却、选图方式、去重、关闭、用户索图识别。')
