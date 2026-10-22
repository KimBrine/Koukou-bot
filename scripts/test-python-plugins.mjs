import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPythonPlugins } from '../src/pythonPlugins.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-py-'))
const plugins = createPythonPlugins({ config: { rootDir: root }, logger: { info() {}, warn() {} } })
let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log('PASS ' + name) }

try {
  test('导入脚本并解析头部元信息', () => {
    const item = plugins.importScript('hello.py', '# name: 打招呼\n# desc: 演示脚本\n# usage: /py hello 名字\nprint("hi")\n')
    assert.equal(item.id, 'hello')
    assert.equal(item.name, '打招呼')
    assert.equal(item.description, '演示脚本')
    assert.equal(item.usage, '/py hello 名字')
    assert.equal(plugins.list().length, 1)
  })

  test('拒绝非法文件名与空内容', () => {
    assert.throws(() => plugins.importScript('../evil.py', 'print(1)'), /文件名/)
    assert.throws(() => plugins.importScript('a b.py', 'print(1)'), /文件名/)
    assert.throws(() => plugins.importScript('x.txt', 'print(1)'), /文件名/)
    assert.throws(() => plugins.importScript('ok.py', '   '), /内容为空/)
  })

  test('拒绝超大脚本', () => {
    assert.throws(() => plugins.importScript('big.py', 'x'.repeat(200 * 1024 + 10)), /200KB/)
  })

  test('同名校验与删除', () => {
    plugins.importScript('hello.py', '# name: 新的\nprint(2)')
    assert.equal(plugins.list().find((x) => x.id === 'hello').name, '新的')
    assert.equal(plugins.remove('hello'), true)
    assert.equal(plugins.list().length, 0)
    assert.throws(() => plugins.remove('hello'), /不存在/)
  })

  test('不存在或非法脚本名运行时报错', async () => {
    await assert.rejects(() => plugins.run('../x', ''), /脚本名无效/)
    await assert.rejects(() => plugins.run('missing', ''), /脚本不存在/)
  })
  test('/py 列表包含脚本名、作用与用法', () => {
    plugins.importScript('demo.py', '# name: 演示脚本\n# desc: 说明文字\n# usage: /py demo x\nprint(1)')
    const text = plugins.helpText()
    assert.match(text, /\/py demo/)
    assert.match(text, /说明文字/)
    assert.match(text, /\/py demo x/)
    plugins.remove('demo')
    assert.match(plugins.helpText(), /还没有 Python 脚本/)
  })
  test('可以单独停用某个脚本', () => {
    plugins.importScript('off.py', '# name: 停用测试\nprint(1)')
    assert.equal(plugins.list().find((x) => x.id === 'off').enabled, true)
    plugins.setEnabled('off', false)
    assert.equal(plugins.list().find((x) => x.id === 'off').enabled, false)
    assert.match(plugins.helpText(), /已停用/)
    assert.equal(plugins.isEnabled('off'), false)
    plugins.setEnabled('off', true)
    assert.equal(plugins.isEnabled('off'), true)
    plugins.remove('off')
  })
  console.log('python plugins checks passed: ' + passed)
} finally {
  rmSync(root, { recursive: true, force: true })
}
