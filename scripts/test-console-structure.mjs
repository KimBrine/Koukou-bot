import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../src/admin/ui.html', import.meta.url), 'utf8')

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

console.log('控制台结构检查通过：' + pages.length + ' 个页面分支、' + buttons.length + ' 个关键按钮、记忆操作绑定齐全')
