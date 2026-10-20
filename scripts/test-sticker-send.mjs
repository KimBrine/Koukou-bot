import assert from 'node:assert/strict'
import {createStickerSendPolicy} from '../src/stickerSend.js'
const event={message_type:'group',group_id:12345,user_id:1},item={id:'x',name:'猫猫'}
const library={count:()=>1,find:q=>q==='猫猫'?item:null,pick:()=>item,random:()=>item}
const config={stickersEnabled:true,stickerAutoRate:.35,stickerMaxPerReply:1,whitelistGroups:new Set([12345])}
let value=0,now=10000
const policy=createStickerSendPolicy({config,stickers:library,rand:()=>value,now:()=>now})
let hits=0
for(let i=0;i<100;i++){value=i/100;if(policy.select(event,{text:'文字',queries:['猫猫']}).items.length)hits++}
assert.equal(hits,35,'模型点名也只按35%配图')
value=0;assert.equal(policy.select(event,{text:' '}).items.length,0)
config.stickerSendScope='whitelist';assert.equal(policy.allowed({...event,group_id:2}),false)
config.stickerSendScope='selected';config.stickerSendGroups=new Set([2]);assert.equal(policy.allowed(event),false)
config.stickerSendScope='private';assert.equal(policy.allowed(event),false);assert.equal(policy.allowed({message_type:'private'}),true)
config.stickerSendScope='all';config.stickerCooldownSeconds=60
policy.begin(event);assert.equal(policy.select(event,{text:'文字'}).items.length,0)
now+=60000;assert.equal(policy.select(event,{text:'文字'}).items.length,1)
config.stickerPickMode='model';assert.equal(policy.select(event,{text:'文字'}).items.length,0)
assert.equal(policy.select(event,{text:'文字',queries:['猫猫','猫猫']}).items.length,1)
config.stickerPickMode='random';assert.equal(policy.select(event,{text:'文字'}).items.length,1)
config.stickersEnabled=false;assert.equal(policy.allowed(event),false)
console.log('配图策略通过：文字前提、35%统一门槛、范围、冷却、选图方式、去重、关闭。')
