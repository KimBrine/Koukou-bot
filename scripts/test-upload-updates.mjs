// 完全离线：模拟GitHub、识图模型和上传DOM，不传输图片或调用付费API。
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {compareVersions,createUpdateChecker} from '../src/updateCheck.js'
import {suggestStickerMetadata} from '../src/stickerMetadata.js'
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
assert.equal(compareVersions('v2.10.0','2.9.9'),1)
assert.equal(compareVersions('v2.17.3','2.17.3'),0)
assert.equal(compareVersions('v2.18.0-beta','2.17.3'),null)
let clock=100000,count=0,resolveFetch
const checker=createUpdateChecker({currentVersion:'2.9.0',now:()=>clock,fetchImpl:()=>{count++;return new Promise(r=>resolveFetch=r)}})
const pending=checker.check(),second=checker.check()
resolveFetch({ok:true,json:async()=>[{name:'v2.9.9'},{name:'v2.10.0'},{name:'v99.0.0-beta'}]})
const a=await pending,b=await second
assert.equal(count,1);assert.equal(a.status,'available');assert.equal(b.latestVersion,'2.10.0');assert.match(a.url,/github.com\/KimBrine\/Koukou-bot\/tree\/v2.10.0$/)
await checker.check({force:true});assert.equal(count,1,'30秒内不反复请求')
clock+=31000;const again=checker.check({force:true});resolveFetch({ok:true,json:async()=>[{name:'v2.9.0'}]});assert.equal((await again).status,'current')
const error=await createUpdateChecker({currentVersion:'2.0.0',fetchImpl:async()=>({ok:false,status:403})}).check()
assert.equal(error.status,'error');assert.match(error.message,/限流/);assert.equal(error.currentVersion,'2.0.0')
const badges=Object.fromEntries(['updateNotice','versionStatus','currentVersion','versionChecked','versionLink'].map(k=>[k,{}]))
const badgeContext=vm.createContext({location:{hash:''},window:{},document:{getElementById:id=>badges[id]}})
const app=readFileSync(new URL('../src/admin/app.js',import.meta.url),'utf8')
vm.runInContext(app.slice(0,app.search(/\r?\nrenderNav\(\)\r?\nload\(\)/)),badgeContext)
vm.runInContext(`updateInfo={currentVersion:'2.9.0',latestVersion:'2.10.0',status:'available',url:'https://github.com/KimBrine/Koukou-bot/tree/v2.10.0'};paintUpdates()`,badgeContext)
assert.match(badges.updateNotice.innerHTML,/发现新版 v2.10.0/);assert.equal(badges.versionLink.hidden,false)
vm.runInContext(`updateInfo={currentVersion:'2.9.0',status:'error',message:'模拟断网'};paintUpdates()`,badgeContext)
assert.match(badges.versionStatus.textContent,/检查失败.*模拟断网/);assert.equal(badges.versionLink.hidden,true)
assert.doesNotMatch(badges.updateNotice.innerHTML,/发现新版/)
let used=0
const client={model:'second-round-vision',describeImages:async(prompt,message,parts)=>{used++;assert.equal(parts[0].image_url.url,PNG);assert.match(prompt,/不适合/);return JSON.stringify({isSticker:true,name:'猫猫',keywords:['开心'],description:'表示开心，不用于嘲笑难过的人',scenes:['happy','invalid']})}}
const draft=await suggestStickerMetadata({dataUrl:PNG,tagLLM:{snapshot:()=>client}})
assert.equal(used,1);assert.equal(draft.model,'second-round-vision');assert.deepEqual(draft.scenes,['happy'])
await assert.rejects(()=>suggestStickerMetadata({dataUrl:'https://example.test/picture',tagLLM:client}),/只支持/)
await assert.rejects(()=>suggestStickerMetadata({dataUrl:PNG}),/尚未配置/)
await assert.rejects(()=>suggestStickerMetadata({dataUrl:PNG,tagLLM:{describeImages:async()=>'{"isSticker":false}'}}),/未确认/)
await assert.rejects(()=>suggestStickerMetadata({dataUrl:PNG,tagLLM:{describeImages:async()=>'{"isSticker":true,"name":"漏字段"}'}}),/字段不完整/)

let html='',fields=[],apiCalls=0,uploads=0,fail=false
const elements=Object.fromEntries(['stickerUploadPanel','stkDrop','stkFile','stkChoose','stkFillAll','stkUpload'].map(k=>[k,{}]))
elements.stkDrop.classList={add(){},remove(){}}
Object.defineProperty(elements.stickerUploadPanel,'outerHTML',{get:()=>html,set:v=>{html=v}})
const document={getElementById:id=>elements[id],querySelectorAll:sel=>{
 if(sel!=='[data-upload-field]')return []
 fields=[...html.matchAll(/data-upload-field="([^"]+)" data-upload-id="([^"]+)"/g)].map(m=>({dataset:{uploadField:m[1],uploadId:m[2]},value:''}));return fields
}}
const context={window:{},document,crypto:{randomUUID:()=> 'test-id'},FileReader:class{readAsDataURL(){this.result=PNG;queueMicrotask(()=>this.onload())}}}
vm.createContext(context);vm.runInContext(readFileSync(new URL('../src/admin/stickerUpload.js',import.meta.url),'utf8'),context)
const ui=context.window.StickerUploadUI
ui.bind({toast(){},onSaved:async()=>{},api:async(route,body)=>{
 if(route.endsWith('sticker-suggest')){apiCalls++;if(fail)throw Error('模拟超时');return {draft}}
 uploads++;assert.equal(body.name,'手工标题');assert.equal(body.description,draft.description);return {}
}})
elements.stkFile.files=[{name:'sample.png',size:100,type:'image/png'}]
await elements.stkFile.onchange();assert.equal(ui.dirty(),true)
const nameField=fields.find(f=>f.dataset.uploadField==='name');nameField.value='手工标题';nameField.oninput()
await elements.stkFillAll.onclick();assert.equal(apiCalls,1);assert.match(html,/value="手工标题"/);assert.match(html,/表示开心/)
await elements.stkUpload.onclick();assert.equal(uploads,1);assert.equal(ui.dirty(),false)
await elements.stkFile.onchange();fail=true;await elements.stkFillAll.onclick();assert.match(html,/模拟超时.*草稿已保留/);assert.equal(ui.dirty(),true)
let prevented=false;elements.stkDrop.ondragover({preventDefault(){prevented=true}})
assert.equal(prevented,true)
console.log('上传与更新检查通过：拖拽/草稿/手填保护/失败保留/第二轮模型/正式版本比较/并发缓存/失败状态；无网络与付费调用。')
