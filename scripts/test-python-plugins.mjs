import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createPythonPlugins } from '../src/pythonPlugins.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-py-'))
const plugins = createPythonPlugins({ config: { rootDir: root }, logger: { info() {}, warn() {} } })
let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name) }

try {
  await test('导入脚本并解析头部元信息', () => {
    const item = plugins.importScript('hello.py', '# name: 打招呼\n# desc: 演示脚本\n# usage: /py hello 名字\nprint("hi")\n')
    assert.equal(item.id, 'hello')
    assert.equal(item.name, '打招呼')
    assert.equal(item.description, '演示脚本')
    assert.equal(item.usage, '/py hello 名字')
    assert.equal(plugins.list().length, 1)
  })

  await test('拒绝非法文件名与空内容', () => {
    assert.throws(() => plugins.importScript('../evil.py', 'print(1)'), /文件名/)
    assert.throws(() => plugins.importScript('a b.py', 'print(1)'), /文件名/)
    assert.throws(() => plugins.importScript('x.txt', 'print(1)'), /文件名/)
    assert.throws(() => plugins.importScript('ok.py', '   '), /内容为空/)
  })

  await test('拒绝超大脚本', () => {
    assert.throws(() => plugins.importScript('big.py', 'x'.repeat(200 * 1024 + 10)), /200KB/)
  })

  await test('同名校验与删除', () => {
    plugins.importScript('hello.py', '# name: 新的\nprint(2)')
    assert.equal(plugins.list().find((x) => x.id === 'hello').name, '新的')
    assert.equal(plugins.remove('hello'), true)
    assert.equal(plugins.list().length, 0)
    assert.throws(() => plugins.remove('hello'), /不存在/)
  })

  await test('不存在或非法脚本名运行时报错', async () => {
    await assert.rejects(() => plugins.run('../x', ''), /脚本名无效/)
    await assert.rejects(() => plugins.run('missing', ''), /脚本不存在/)
  })
  await test('/py 列表包含脚本名、作用与用法', () => {
    plugins.importScript('demo.py', '# name: 演示脚本\n# desc: 说明文字\n# usage: /py demo x\nprint(1)')
    const text = plugins.helpText()
    assert.match(text, /\/py demo/)
    assert.match(text, /说明文字/)
    assert.match(text, /\/py demo x/)
    plugins.remove('demo')
    assert.match(plugins.helpText(), /还没有 Python 脚本/)
  })
  await test('可以单独停用某个脚本', () => {
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
  await test('执行入口强制UTF-8，覆盖外部GBK配置并显式解码', async () => {
    plugins.importScript('unicode.py', 'print("中文")')
    let actual
    const mocked = createPythonPlugins({config:{rootDir:root},execFileImpl(command,args,options,callback){actual={command,args,options};callback(null,'中文输出🦀','中文错误')}})
    const result=await mocked.run('unicode','"中文参数"')
    assert.deepEqual(actual.args.slice(0,2),['-X','utf8'])
    assert.equal(actual.args.at(-1),'中文参数');assert.equal(actual.options.encoding,'utf8')
    assert.equal(actual.options.env.PYTHONUTF8,'1');assert.equal(actual.options.env.PYTHONIOENCODING,'utf-8')
    assert.equal(result.stdout,'中文输出🦀');assert.equal(result.stderr,'中文错误')
  })
  const python = ['python','python3'].find(command => spawnSync(command,['--version'],{windowsHide:true}).status===0)
  if(python) await test('真实Python管道正确返回中文、emoji、参数和子进程输出', async () => {
    plugins.importScript('unicode.py', 'import sys, subprocess\nprint(sys.argv[1])\nprint(sys.stdout.encoding.lower())\nprint("中文错误🦀", file=sys.stderr)\nr=subprocess.run([sys.executable,"-c",\'print("子进程中文🦀")\'],capture_output=True,encoding="utf-8",check=True)\nprint(r.stdout.strip())\n')
    const previous={PYTHONUTF8:process.env.PYTHONUTF8,PYTHONIOENCODING:process.env.PYTHONIOENCODING}
    try{
      process.env.PYTHONUTF8='0';process.env.PYTHONIOENCODING='gbk'
      const real=createPythonPlugins({config:{rootDir:root},pythonPath:python})
      const result=await real.run('unicode','"中文参数🦀"')
      assert.equal(result.ok,true,result.stderr)
      assert.equal(result.stdout.replace(/\r\n/g,'\n'),'中文参数🦀\nutf-8\n子进程中文🦀')
      assert.equal(result.stderr,'中文错误🦀')
    }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
  })
  else console.log('SKIP 真实Python管道测试：未安装Python；启动选项验证已通过')
  await test('调用别名、保留词、撤回秒数和旧分钟字段',()=>{
    plugins.importScript('alias.py','print(1)')
    assert.equal(plugins.setCommandName('alias','小工具'),'小工具')
    assert.equal(plugins.resolveId('小工具'),'alias')
    assert.equal(plugins.list().find(x=>x.id==='alias').command,'小工具')
    assert.throws(()=>plugins.setCommandName('alias','help'),/保留词/)
    assert.equal(plugins.setSettings({recallMinutes:2}).recallSeconds,120)
    assert.equal(plugins.setSettings({recallSeconds:15}).recallSeconds,15)
    assert.throws(()=>plugins.setSettings({recallSeconds:4}),/5~7200/)
    plugins.setEnabled('alias',false)
    assert.equal(plugins.isEnabled('小工具'),false)
  })
  await test('停用表或设置损坏不能静默恢复默认',()=>{
    writeFileSync(path.join(plugins.dir,'disabled.json'),'{')
    assert.throws(()=>plugins.isEnabled('alias'))
    writeFileSync(path.join(plugins.dir,'disabled.json'),'[]')
    writeFileSync(path.join(plugins.dir,'settings.json'),'[')
    assert.throws(()=>plugins.getSettings())
  })
  console.log('python plugins checks passed: ' + passed)
} finally {
  rmSync(root, { recursive: true, force: true })
}
