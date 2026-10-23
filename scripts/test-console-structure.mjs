import assert from 'node:assert/strict'
import { readUiSource } from './ui-source.mjs'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readUiSource()

// 导航里的每个页面都必须有渲染分支（之前「表情包」掉了分支，点了显示成记忆）
const pagesBlock = html.match(/const PAGES = \[([\s\S]*?)\n\]/)[1]
const pages = [...pagesBlock.matchAll(/\['([a-z]+)'/g)].map((m) => m[1])
assert.ok(pages.length >= 10, '导航页面数量异常：' + pages.length)
for (const page of pages) {
  assert.ok(new RegExp(`page === '${page}'`).test(html), `render() 缺少页面分支：${page}`)
}

// 关键按钮：既要出现在 DOM 里，也要有事件绑定，缺一个就是「点了没反应」
const buttons = ['addchat', 'cleanGroups', 'importWhitelist', 'stkRulesSave', 'wsSave', 'vcSave', 'stkUpload']
for (const id of buttons) {
  assert.ok(html.includes(`id="${id}"`), `页面缺少按钮 #${id}`)
  assert.ok(html.includes(`getElementById('${id}')`), `按钮 #${id} 没有绑定事件`)
}
// 配置表单按卡片分作用域保存：同一页多个卡片各有自己的保存按钮，不能共用一个 id
assert.ok(html.includes('data-cfgsave'), '缺少配置保存按钮')
assert.ok(html.includes("[data-cfgsave]"), '配置保存按钮没有绑定事件')
assert.ok(html.includes('data-cfg-scope'), '配置表单缺少独立作用域，同页多个保存按钮会互相抢')

// 记忆浏览：查看 / 改 / 删 / 清空 四个动作都要绑上（历史上漏过）
for (const attr of ['data-memview', 'data-mem-edit', 'data-mem-del', 'data-memclear']) {
  assert.ok(html.includes(attr), `缺少 ${attr}`)
  assert.ok(html.includes(`querySelectorAll('[${attr}]`), `${attr} 没有绑定事件`)
}

const app=readFileSync(new URL('../src/admin/app.js',import.meta.url),'utf8')
const context=vm.createContext({location:{hash:'#chats'},window:{},document:{getElementById(){return null}}})
vm.runInContext(app.slice(0,app.search(/\r?\nrenderNav\(\)\r?\nload\(\)/)),context)
const row=type=>vm.runInContext(`chatRow({type:${JSON.stringify(type)},key:'${type==='group'?'g':'p'}200000002',id:200000002,name:'测试会话',raw:{proactiveEnabled:false,proactiveRate:.2},effective:{proactiveRate:.1,emojiKeepRate:.35}})`,context)
const privateRow=row('private'),groupRow=row('group')
assert.doesNotMatch(privateRow,/data-f="proactiveEnabled"|data-f="proactiveRate"|data-global="proactiveRate"|>不主动<|被 @ \/ 引用时回复/)
assert.match(privateRow,/回复私聊消息/);assert.match(privateRow,/data-f="atReplyEnabled"/)
assert.match(groupRow,/data-f="proactiveEnabled"/);assert.match(groupRow,/data-f="proactiveRate"/)
assert.match(groupRow,/被 @ \/ 引用时回复/)
assert.equal(vm.runInContext('Object.keys(proactiveSettingsPatch({querySelector(){return null}})).length',context),0,'私聊保存不访问不存在的概率输入框，也不提交群聊专属设置')
const patch=vm.runInContext(`proactiveSettingsPatch({querySelector(s){return s.includes('data-global')?{checked:false}:s.includes('proactiveEnabled')?{checked:false}:{value:'.25'}}})`,context)
assert.equal(patch.proactiveEnabled,false);assert.equal(patch.proactiveRate,.25)
assert.match(app,/const cur = stickerSettings \|\| \{\}/,'表情包保存用全局 stickerSettings，不引用只在页面作用域里的 settings')
console.log('控制台结构及私聊设置检查通过：私聊不展示/提交群聊概率，群聊设置保留。')

// QQ真实群名不能被会话占位名覆盖；满库时两个学习开关仍须禁用。
vm.runInContext(`joinedGroups=[{id:'200000002',name:'真实测试群'}];chats=[{type:'group',id:'200000002',name:'群 200000002'},{type:'group',id:'200000003',name:'群 200000003'}];stickerLearn={enabled:true,private:true,groups:[200000002],full:false}`,context)
let stickerPage=vm.runInContext('pageStickers()',context)
assert.match(stickerPage,/真实测试群（200000002）/)
assert.match(stickerPage,/群聊（200000003）/)
assert.doesNotMatch(stickerPage,/群 200000002|群 200000003/)
for(const id of ['stkLearnToggle','stkLearnPrivate']) assert.match(stickerPage,new RegExp('role="switch" id="'+id+'" checked'))
vm.runInContext('stickerLearn={enabled:false,private:true,full:true}',context)
stickerPage=vm.runInContext('pageStickers()',context)
for(const id of ['stkLearnToggle','stkLearnPrivate']) assert.match(stickerPage,new RegExp('role="switch" id="'+id+'" disabled'))
console.log('表情包学习界面检查通过：真实群名、群号去重、滑动开关与满库禁用。')

// Summary roster has a visible entry and its own save scope, with names and manual fallback.
vm.runInContext("joinedGroups=[{id:'200000002',name:'示例总结群'}];chats=[];state={config:{}};configItems=[{key:'SUMMARY_ENABLED',label:'自动总结',effective:'1',value:'1',type:'bool',live:false},{key:'SUMMARY_GROUPS',label:'目标群',effective:'200000002,200000003',value:'',type:'text',live:false}]",context)
const reportPage=vm.runInContext('pageReport()',context)
assert.match(reportPage,/自动群总结 · 群名单/)
assert.match(reportPage,/data-cfg-scope="summary-roster"/)
assert.match(reportPage,/示例总结群（200000002）/)
assert.match(reportPage,/data-summary-pick="200000003" checked/)
assert.equal((reportPage.match(/data-cfg="SUMMARY_GROUPS"/g)||[]).length,1)
assert.match(reportPage,/留空会使用全部白名单群/)
assert.match(vm.runInContext('pageChats()',context),/href="#report">管理自动总结群名单/)
