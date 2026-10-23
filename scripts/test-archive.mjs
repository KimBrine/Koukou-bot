// 离线：打包模块（格式、压缩次数、清理）——需要本机有 7-Zip 或 PowerShell
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createArchive, findSevenZip, normalizeFormat, normalizePasses, findRar } from '../src/archive.js'

let pass = 0
const check = (name, ok) => {
  assert.ok(ok, name)
  pass++
  console.log('PASS', name)
}

check('格式只接受 zip/7z', normalizeFormat('7Z') === '7z' && normalizeFormat('rar') === 'rar')
check('压缩次数夹在 1～5', normalizePasses(0) === 1 && normalizePasses(9) === 5 && normalizePasses('3') === 3)

const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-test-'))
const src = path.join(dir, 'album')
mkdirSync(src, { recursive: true })
writeFileSync(path.join(src, 'a.txt'), 'hello ' + 'x'.repeat(2000))
writeFileSync(path.join(src, 'b.txt'), 'world')

const archive = createArchive()
console.log('7-Zip =', archive.sevenZipPath || '(未找到，zip 走 Compress-Archive)')

const one = await archive.pack(src, { format: 'zip', passes: 1 })
check('zip 打包生成文件', existsSync(one.file) && one.file.endsWith('.zip'))
check('返回格式与次数', one.format === 'zip' && one.passes === 1)
const sizeOne = existsSync(one.file) ? 1 : 0
one.cleanup()
check('cleanup 清掉临时目录', !existsSync(one.file) && sizeOne === 1)

const two = await archive.pack(src, { format: 'zip', passes: 2 })
check('压缩两次生成嵌套包', existsSync(two.file) && two.file.endsWith('album.2.zip'))
two.cleanup()

if (archive.sevenZipPath) {
  const seven = await archive.pack(src, { format: '7z', passes: 1 })
  check('7z 打包生成文件', existsSync(seven.file) && seven.file.endsWith('.7z'))
  seven.cleanup()
} else {
  let failed = false
  try { await archive.pack(src, { format: '7z', passes: 1 }) } catch (err) { failed = /7-Zip/.test(err.message) }
  check('没有 7-Zip 时 7z 明确报错', failed)
}

check('findSevenZip 支持显式路径不存在时回落', typeof findSevenZip({ sevenZipPath: path.join(dir, 'nope.exe') }) === 'string')
// Simulated RAR CLI: paths with spaces, real output checks, nested rounds and safe cleanup.
const toolDir=path.join(dir,'tools with spaces');mkdirSync(toolDir)
const fake=path.join(toolDir,process.platform==='win32'?'Rar.exe':'rar');writeFileSync(fake,'test stub')
assert.equal(findRar('"'+toolDir+'"'),fake)
let calls=0
const mock=createArchive({rarPath:fake,async runImpl(exe,args,options){
 assert.equal(exe,fake);assert.equal(args[0],'a');assert.equal(args[1],'-ma5');assert.equal(args.at(-2),'--')
 assert.equal(options.windowsHide,true);calls++;writeFileSync(args[5],'Rar!mock');return {stdout:'',stderr:''}
}})
const rar=await mock.pack(src,{format:'rar',passes:2,outDir:dir})
assert.equal(calls,2);assert.ok(rar.file.endsWith('.2.rar'));rar.cleanup();assert.equal(existsSync(src),true)
const broken=createArchive({rarPath:fake,async runImpl(){throw Error('offline failure')}})
const before=new Set((await import('node:fs')).readdirSync(dir))
await assert.rejects(broken.pack(src,{format:'rar',outDir:dir}),/offline failure/)
assert.deepEqual(new Set((await import('node:fs')).readdirSync(dir)),before,'失败只清理自建临时目录')
rmSync(dir, { recursive: true, force: true })
console.log(`archive checks passed: ${pass}`)
