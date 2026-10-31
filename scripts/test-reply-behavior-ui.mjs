import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {readUiScript} from './ui-source.mjs'
const source=readUiScript()
const ctx=vm.createContext({URL,location:{hash:'#humanize'},window:{},document:{getElementById(){return null}}})
vm.runInContext(source.slice(0,source.search(/\r?\nrenderNav\(\)\r?\nload\(\)/)),ctx)
const run=code=>vm.runInContext(code,ctx)
ctx.schema=JSON.parse(readFileSync(new URL('../python/koukou/admin_schema.json',import.meta.url),'utf8'))
run(`configItems=schema.map(x=>({...x,effective:x.type==='bool'?'0':'',value:''}));state={backend:{provider:'qq-official',capabilities:{}},config:{}}`)
let html=run('pageHumanize()')
assert.match(html,/输入状态与发送节奏/)
for(const key of ['TYPING_STATUS_ENABLED','REPLY_PACING_ENABLED','FIXED_REPLY_VARIATION_ENABLED'])assert.match(html,new RegExp('data-cfg="'+key+'"'))
assert.match(html,/不等于逐字操作/)
assert.match(run(`configForm(['TYPING_STATUS_ENABLED'])`),/<fieldset disabled/)
run(`state.backend={provider:'onebot',implementation:'snowluma'}`)
assert.doesNotMatch(run(`configForm(['TYPING_STATUS_ENABLED'])`),/<fieldset disabled/)
html=run('pageLogin()')
assert.match(html,/SnowLuma连接/);assert.match(html,/ONEBOT_WS_URL/)
assert.doesNotMatch(html,/id="qqQr"|id="qqLogout"/)
console.log('Reply behavior UI passed: independent switches, truthful typing availability and SnowLuma connection fields.')
