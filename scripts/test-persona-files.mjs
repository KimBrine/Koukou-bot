// 临时人格库与模拟浏览器下载；不连接 QQ、不调用模型、不改部署人格。
import assert from 'node:assert/strict'
import { readUiSource, readUiScript } from './ui-source.mjs'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {createAdminServer} from '../src/admin/server.js'

const root=mkdtempSync(path.join(os.tmpdir(),'koukou-persona-files-'))
const envFile=path.join(root,'.env')
writeFileSync(envFile,'ACTIVE_PERSONA=原人格\nUNRELATED=keep\n')
const config={rootDir:root,dataDir:root,envFile,botName:'测试机器人',persona:'正在使用的原人格',activePersona:'原人格',deepseekApiKey:'secret-not-for-export'}
const admin=createAdminServer({config})
let passed=0
async function test(name,fn){await fn();passed++;console.log(`PASS ${name}`)}
try{
  await admin.actions['create-persona']({name:'原人格',content:'原文件中保存的版本'})
  await test('导出运行中实际人格，区别于已保存的草稿，不混入其他配置',async()=>{
    const result=await admin.actions['export-persona']()
    assert.equal(result.content,'正在使用的原人格');assert.equal(result.filename,'Koukou-原人格-人格.txt')
    assert.deepEqual(Object.keys(result).sort(),['content','filename','name'])
    assert.doesNotMatch(JSON.stringify(result),/secret-not-for-export/)
    assert.equal((await admin.actions['get-persona']({name:'原人格'})).content,'原文件中保存的版本')
  })
  await test('导入多个人格持久保存，默认不改变当前人格，切换后导出跟随生效人格',async()=>{
    const content='你是示例群友。\n自然聊天，保留段落。'
    await admin.actions['import-persona']({name:'群友A',content:'\uFEFF'+content})
    await admin.actions['import-persona']({name:'群友B',content:'第二个人格'})
    assert.equal(config.persona,'正在使用的原人格');assert.equal(config.activePersona,'原人格')
    assert.equal(readFileSync(path.join(root,'personas','群友A.txt'),'utf8'),content)
    assert.equal(admin.listPersonas().length,3)
    await admin.actions['activate-persona']({name:'群友A'})
    assert.equal(config.persona,content);assert.equal((await admin.actions['export-persona']()).content,content)
    assert.match(readFileSync(envFile,'utf8'),/ACTIVE_PERSONA=群友A/);assert.match(readFileSync(envFile,'utf8'),/UNRELATED=keep/)
    await admin.actions['activate-persona']({name:'群友B'})
    await admin.actions['activate-persona']({name:'原人格'})
    assert.equal(config.persona,'原文件中保存的版本');assert.equal(admin.listPersonas().length,3)
    const restored=createAdminServer({config:{...config}})
    try{assert.equal(restored.listPersonas().length,3);assert.equal((await restored.actions['get-persona']({name:'群友A'})).content,content)}
    finally{restored.server.close()}
  })
  await test('同名或大小写别名不覆盖，空白、路径、二进制和过大内容被拒绝',async()=>{
    await assert.rejects(admin.actions['import-persona']({name:'群友A',content:'替换'}),/同名/)
    await assert.rejects(admin.actions['import-persona']({name:'群友a',content:'替换'}),/同名/)
    for(const name of ['', '../其他人格','C:\\人格','CON','NUL.txt','名字.','名字\u0000'])
      await assert.rejects(admin.actions['import-persona']({name,content:'正文'}))
    for(const content of ['', '\n\t','含\u0000二进制','字'.repeat(262145),{text:'object'}])
      await assert.rejects(admin.actions['import-persona']({name:'无效',content}))
    assert.equal(admin.listPersonas().length,3)
    assert.equal((await admin.actions['get-persona']({name:'群友A'})).content,'你是示例群友。\n自然聊天，保留段落。')
  })
  await test('未配置自定义人格时可导出默认人格，文件名不能变成路径',async()=>{
    const previous={...config}
    try{
      config.persona='';config.activePersona='';config.botName='例/子'
      const result=await admin.actions['export-persona']()
      assert.match(result.content,/例\/子/);assert.equal(result.filename,'Koukou-例_子-人格.txt')
    }finally{Object.assign(config,previous)}
  })
  const html = readUiSource()
  const script=readUiScript()
  new vm.Script(script)
  const helper=script.slice(script.indexOf('function downloadPersonaFile'),script.indexOf('function previewPersonaImport'))
  const blobs=[],downloads=[],timers=[],revoked=[]
  const ui=vm.createContext({Blob,TextDecoder,Uint8Array,personas:[{name:'原人格'}],setTimeout:fn=>timers.push(fn),
    URL:{createObjectURL:blob=>{blobs.push(blob);return 'blob:mock'},revokeObjectURL:url=>revoked.push(url)},
    document:{body:{appendChild(){}},createElement(){return {click(){downloads.push({href:this.href,name:this.download})},remove(){}}}}})
  vm.runInContext(helper,ui)
  const file=(name,bytes)=>({name,size:bytes.length,async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}})
  await test('导出中文和未保存编辑内容为 UTF-8 文件，点击下载后释放资源',async()=>{
    ui.downloadPersonaFile('人格.txt','编辑中的内容\n第二行')
    const bytes=new Uint8Array(await blobs[0].arrayBuffer())
    assert.deepEqual([...bytes.slice(0,3)],[0xef,0xbb,0xbf])
    assert.equal(new TextDecoder().decode(bytes),'编辑中的内容\n第二行')
    assert.equal(downloads[0].name,'人格.txt');timers.forEach(fn=>fn());assert.deepEqual(revoked,['blob:mock'])
  })
  await test('导入 UTF-8/BOM、UTF-16 和常见中文编码，空文件及错误类型不进入人格库',async()=>{
    const content='中文人格\n保持语气'
    for(const bytes of [Buffer.from(content),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(content)]),
      Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(content,'utf16le')])])
      assert.equal(await ui.readPersonaFile(file('人格.txt',bytes)),content)
    assert.equal(await ui.readPersonaFile(file('人格.md',Buffer.from([0xc4,0xe3,0xba,0xc3]))),'你好')
    await assert.rejects(ui.readPersonaFile(file('人格.json',Buffer.from('{}'))),/txt/)
    await assert.rejects(ui.readPersonaFile(file('人格.txt',Buffer.from('\u0000data'))),/纯文本/)
    await assert.rejects(ui.readPersonaFile(file('人格.txt',Buffer.from('  '))),/文件为空/)
    await assert.rejects(ui.readPersonaFile({name:'large.txt',size:262145}),/256/)
    assert.equal(ui.suggestPersonaName('Koukou-原人格-人格-2026-10-13.txt'),'原人格（2）')
    assert.equal(ui.suggestPersonaName('新的群友.md'),'新的群友')
  })
  console.log(`${passed} cases passed`)
}finally{
  admin.server.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('koukou-persona-files-'));rmSync(root,{recursive:true,force:true})
}
