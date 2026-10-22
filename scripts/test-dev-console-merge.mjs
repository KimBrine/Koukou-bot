import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import {openPathOnHost} from '../src/openPath.js'
const root=path.resolve('mock root'),target=path.join(root,'plugins','python','测试目录','demo.py')
let captured
const invoke=async(select=false)=>openPathOnHost({rootDir:root,target,select,platform:'win32',execFileImpl(command,args,options,callback){captured={command,args,options};callback(null)}})
let result=await invoke(true)
assert.deepEqual(captured.args,['//B','//Nologo',path.join(root,'scripts','open-path.vbs'),target,'select'])
assert.equal(captured.command,'wscript.exe');assert.equal(captured.options.windowsHide,true)
assert.equal(result.mode,'select');assert.match(result.warning,/请求/)
await invoke(false);assert.equal(captured.args.at(-1),'folder')
await assert.rejects(openPathOnHost({rootDir:root,target,platform:'linux'}),/仅Windows/)
await assert.rejects(openPathOnHost({rootDir:root,target,platform:'win32',execFileImpl(c,a,o,cb){cb(new Error('helper error'))}}),/helper error/)
const app=readFileSync(new URL('../src/admin/app.js',import.meta.url),'utf8')
const card={open:true},row={open:true,dataset:{pyrow:'demo'}},editor={id:'pyEditor-demo',style:{display:''}},input={dataset:{pysrc:'demo'},value:'人工未保存内容<&',closest(){return editor}}
const document={getElementById(){return null},querySelector(s){return s==='details[data-pycard]'?card:null},querySelectorAll(s){return s==='details[data-pyrow]'?[row]:s==='[id^="pyEditor-"]'?[editor]:s==='[data-pysrc]'?[input]:[]}}
const context=vm.createContext({location:{hash:'#commands'},window:{},document})
vm.runInContext(app.slice(0,app.search(/\r?\nrenderNav\(\)\r?\nload\(\)/)),context)
vm.runInContext(`pythonScripts=[{id:'demo',name:'测试',path:'demo.py'}];syncPyOpen()`,context)
let html=vm.runInContext('pythonCard()',context)
assert.match(html,/data-pyrow="demo" open/);assert.match(html,/人工未保存内容&lt;&amp;/)
input.value='';vm.runInContext('syncPyOpen()',context)
assert.equal(vm.runInContext('pyDrafts.demo',context),'','人工清空的草稿不能被恢复成磁盘旧内容')
vm.runInContext(`metricsInfo=[{date:'2026-10-22',received:1,replied:3,skipped:0}];`,context)
html=vm.runInContext('pageMetrics()',context);assert.match(html,/统计差额/);assert.match(html,/不是实际|不代表已经逐条归类/);assert.match(html,/>-2</)
// Repeated titles and numeric identities must restore only the originally open panel.
const panels=['image1','image2'].map((id,i)=>({open:i===0,getAttribute:a=>a==='data-stk-detail'?id:null}))
const oldAll=document.querySelectorAll
let visiblePanels=panels
const originalAll=document.querySelectorAll.bind(document)
document.querySelectorAll=s=>s==='#main details'?visiblePanels:originalAll(s)
context.panels=panels
const capturedOpen=vm.runInContext('captureOpenDetails()',context)
panels.forEach(p=>{p.open=false});context.capturedOpen=capturedOpen
vm.runInContext('restoreOpenDetails(capturedOpen)',context)
assert.equal(panels[0].open,true);assert.equal(panels[1].open,false)
const parent={id:'main',children:[]}
const dated=day=>({getAttribute:()=>null,parentElement:parent,querySelector:()=>({cloneNode:()=>({textContent:day,querySelectorAll:()=>[]})})})
const first=dated('2026-10-21'),second=dated('2026-10-22');parent.children=[first,second]
context.first=first;context.second=second
assert.notEqual(vm.runInContext('detailKey(first)',context),vm.runInContext('detailKey(second)',context))
// Use actual delete binding with a minimal DOM; recreated IDs must not receive old code.
let alive=true
row.remove=()=>{alive=false}
const button={dataset:{pydel:'demo'},closest:()=>row}
document.querySelectorAll=s=>s==='[data-pydel]'?[button]:s==='details[data-pyrow]'?(alive?[row]:[]):s==='[id^="pyEditor-"]'?(alive?[editor]:[]):s==='[data-pysrc]'?(alive?[input]:[]):[]
input.value='旧脚本草稿'
vm.runInContext(`syncPyOpen();ask=async()=>true;toast=()=>{};load=async()=>{pythonScripts=[];syncPyOpen()};render=()=>{}`,context)
context.fetch=async()=>({ok:true,json:async()=>({ok:true})})
const deleteStart=app.indexOf("  document.querySelectorAll('[data-pydel]')")
const deleteEnd=app.indexOf("  document.querySelectorAll('[data-pytoggle]')",deleteStart)
vm.runInContext(app.slice(deleteStart,deleteEnd),context)
await button.onclick()
assert.equal(alive,false);assert.equal(vm.runInContext('pyDrafts.demo',context),undefined)
vm.runInContext(`pythonScripts=[{id:'demo',name:'新脚本'}]`,context)
assert.doesNotMatch(vm.runInContext('pythonCard()',context),/旧脚本草稿|data-pyrow="demo" open/)
console.log('Dev console merge checks passed: per-instance open helper, failure reporting, editor drafts, fold rows and truthful metrics.')
