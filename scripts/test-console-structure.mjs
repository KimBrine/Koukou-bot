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
const buttons = ['addchat', 'cleanGroups', 'saveCfg', 'importWhitelist', 'stkRulesSave', 'wsSave', 'vcSave', 'stkUpload']
for (const id of buttons) {
  assert.ok(html.includes(`id="${id}"`), `页面缺少按钮 #${id}`)
  assert.ok(html.includes(`getElementById('${id}')`), `按钮 #${id} 没有绑定事件`)
}

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
console.log('控制台结构及私聊设置检查通过：私聊不展示/提交群聊概率，群聊设置保留。')
