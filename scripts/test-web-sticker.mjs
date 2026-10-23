import assert from 'node:assert/strict'
import { findWebSticker } from '../src/webSticker.js'
import { createBot } from '../src/bot.js'
const logger={info(){},warn(){},debug(){},error(){}}
const bytes=Buffer.alloc(4096,1);bytes.set([0x89,0x50,0x4e,0x47]);bytes.writeUInt32BE(300,16);bytes.writeUInt32BE(300,20)
const base={text:'帮我联网找张拉普兰德表情包',config:{stickerSearchRewrite:false,stickerSearchProvider:'bing'},logger}
let requests=[],reviews=0
const fakeFetch=async url=>{
 requests.push(url)
 if(url.includes('bing.com'))return {ok:true,text:async()=>'<a m="{&quot;murl&quot;:&quot;https://x.example/bad.png&quot;,&quot;t&quot;:&quot;中国邮政特种邮票&quot;}"></a>'}
 if(url.includes('baidu.com'))return {ok:true,json:async()=>({data:[{middleURL:'https://x.example/cat.png',fromPageTitle:'拉普兰德表情包'}]})}
 if(url.includes('image.so.com'))return {ok:true,json:async()=>({list:[]})}
 return {ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>bytes}
}
const vision={snapshot:()=>({describeImages:async(prompt,user)=>{reviews++;assert.match(prompt,/人物/);assert.match(user,/拉普兰德/);return '是，符合人物和聊天用途。'}})}
const image=await findWebSticker({...base,vision,fetchImpl:fakeFetch})
assert.equal(image.sourceUrl,'https://x.example/cat.png');assert.equal(reviews,1)
assert.ok(requests.some(url=>url.includes('baidu.com')));assert.ok(!requests.includes('https://x.example/bad.png'))
await assert.rejects(findWebSticker({...base,vision:{describeImages:async()=>{throw Error('模型暂时不可用')}},fetchImpl:fakeFetch}),/均未通过/)
await assert.rejects(findWebSticker({...base,vision:{describeImages:async()=> '否，人物不匹配'},fetchImpl:fakeFetch}),/均未通过/)
await assert.rejects(findWebSticker({...base,vision:{describeImages:async()=>{throw Object.assign(Error('凭据无效'),{status:401})}},fetchImpl:fakeFetch}),/凭据无效/)
await assert.rejects(findWebSticker({...base,fetchImpl:fakeFetch}),/复核模型不可用/)
reviews=0
await assert.rejects(findWebSticker({...base,vision,fetchImpl:fakeFetch,isBlocked:()=>true}),/黑名单/)
assert.equal(reviews,0)
requests=[];await assert.rejects(findWebSticker({...base,vision,current:()=>false,fetchImpl:fakeFetch}),{code:'STALE_STICKER_REQUEST'});assert.equal(requests.length,0)
let rewriteInput=''
await findWebSticker({...base,config:{...base.config,stickerSearchRewrite:true},vision,fetchImpl:fakeFetch,llm:{chat:async(_,rows)=>{rewriteInput=rows[0].content;return '拉普兰德 表情包'}}})
assert.match(rewriteInput,/帮我联网找张拉普兰德/)

function fixture({confirmed=true,stale=false,blocked=false}={}){
 const sent=[],history=[],B=200000010,G=200000002
 const config={whitelistGroups:new Set([G]),mutedGroups:new Set(),stickersEnabled:true,stickerAutoRate:0,quietHours:'',contextRememberAll:true}
 const onebot={selfId:B,sendGroup:async(g,text)=>{sent.push(text);return confirmed?{message_id:sent.length}:undefined}}
 const bot=createBot({config,logger,onebot,memory:{get:()=>history,push:(k,role,content)=>history.push({role,content})},buildSystemPrompt:()=>'',
  stickers:{count:()=>0,isBlocked:()=>blocked},webStickerSearch:async()=>{if(stale)config.quietHours='00:00-24:00';return {dataUrl:'data:image/png;base64,'+bytes.toString('base64'),hash:'hash'}},
  llm:{chat:async()=>{throw Error('不应走普通对话模型')}}})
 const evt={message_type:'group',group_id:G,user_id:200000011,message_id:1,time:Date.now()/1000,message:[{type:'at',data:{qq:B}},{type:'text',data:{text:'帮我联网找张表情包'}}]}
 return {sent,history,run:()=>bot.handleMessage(evt)}
}
const normal=fixture();await normal.run();assert.equal(normal.sent.length,2);assert.equal(typeof normal.sent[0],'string');assert.equal(normal.sent[1][0].type,'image')
const noReceipt=fixture({confirmed:false});await noReceipt.run();assert.equal(noReceipt.sent.length,1,'配套文字未确认，不继续发送图片')
const stale=fixture({stale:true});await stale.run();assert.equal(stale.sent.length,0)
const blocked=fixture({blocked:true});await blocked.run();assert.equal(blocked.sent.length,0)
console.log('Web sticker fallback, relevance/review failures, blacklist, stale requests, empty library and confirmed text-before-image delivery passed. No external calls.')
