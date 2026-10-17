// 使用全新实例与虚构资料核对发布默认值；不读取生产配置、不联网。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createAdminServer } from '../src/admin/server.js'
import { loadVisionKnowledge } from '../src/visionKnowledge.js'
import { loadPokeReplies } from '../src/pokeReplies.js'
import { conversationRules } from '../src/conversationRules.js'
import { decorationHint, ensureDecoration, pickDecorationKind } from '../src/replyShape.js'
import { pickImageFallback } from '../src/visionNote.js'
import { readLocalProfile } from '../src/localProfile.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-private-profiles-'))
const repo = fileURLToPath(new URL('..', import.meta.url)), logger = { info() {}, warn() {} }
let passed=0
function test(name, run) { return Promise.resolve(run()).then(()=>{passed++;console.log(`PASS ${name}`)}) }
function config(profile) {
  const dir=path.join(root,profile);mkdirSync(dir,{recursive:true})
  const envFile=path.join(dir,'.env');if(!profile.endsWith('existing'))writeFileSync(envFile,'')
  const probe=`import {loadConfig} from './src/config.js';const c=loadConfig();console.log(JSON.stringify({persona:c.persona,personaDir:c.personaDir,botName:c.botName,activePersona:c.activePersona,localProfile:c.localProfile,pokeRepliesFile:c.pokeRepliesFile}));`
  const env=Object.fromEntries(['PATH','SystemRoot','TEMP','TMP','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',probe],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...env,BOT_ENV_FILE:envFile,BOT_DATA_DIR:dir,BOT_LOG_DIR:path.join(dir,'logs')}}))
}
try {
  await test('首次启动为通用助手，不加载仓库旧人格、专属语料或参考图',()=>{
    const c=config('fresh')
    assert.equal(c.botName,'Koukou');assert.equal(c.activePersona,'');assert.deepEqual(c.localProfile,{})
    assert.match(c.persona,/聊天助手/);assert.doesNotMatch(c.persona,/小口口子|小男娘|雌二醇|🍥|{{BOT_NAME}}/)
    assert.equal(c.personaDir,path.join(root,'fresh','personas'));assert.equal(loadVisionKnowledge(path.join(root,'fresh'),logger),null)
    assert.doesNotMatch(loadPokeReplies(repo,logger,c.pokeRepliesFile).join(''),/小口口子|人家|本口|🍥/)
    assert.doesNotMatch(conversationRules(c),/🍥|小口口子/)
    assert.equal(pickDecorationKind(()=>0), 'persona');assert.deepEqual(ensureDecoration(['你好'],'你好'),['你好'])
    assert.doesNotMatch(decorationHint(true),/🍥|宝宝|人家|卖萌/)
  })
  await test('每个实例使用独立人格库，导入后不自动激活且不出现在另一实例',async()=>{
    const a=config('a'),b=config('b')
    const full=c=>({...c,rootDir:repo,dataDir:path.dirname(c.personaDir),envFile:path.join(path.dirname(c.personaDir),'.env')})
    const adminA=createAdminServer({config:full(a)}),adminB=createAdminServer({config:full(b)})
    try {
      await adminA.actions['import-persona']({name:'示例角色',content:'虚构示例角色，严肃简洁。'})
      assert.equal(adminA.listPersonas().length,1);assert.equal(adminB.listPersonas().length,0)
      assert.equal((await adminA.actions['export-persona']()).content,a.persona)
      assert.match(readFileSync(path.join(a.personaDir,'示例角色.txt'),'utf8'),/虚构示例/)
    } finally {adminA.server.close();adminB.server.close()}
  })
  await test('明确选定的私有人格与私有风格优先，文件缺失报错而非悄悄换人',()=>{
    const dir=path.join(root,'existing');mkdirSync(path.join(dir,'personas'),{recursive:true})
    writeFileSync(path.join(dir,'personas','示例甲.txt'),'私有示例甲的原始人格。')
    writeFileSync(path.join(dir,'.env'),'ACTIVE_PERSONA=示例甲\nBOT_NAME=示例甲\n')
    writeFileSync(path.join(dir,'profile.local.json'),JSON.stringify({conversationRules:'专属规则：称呼对方为朋友。',decoration:{symbol:'⭐',kaomoji:[':)'],weights:{emoji:1}},imageFallbackReplies:['私有读图兜底']}))
    const c=config('existing');assert.equal(c.persona,'私有示例甲的原始人格。');assert.match(conversationRules(c),/专属规则/)
    const preset=c.localProfile.decoration;assert.equal(pickDecorationKind(()=>0,preset),'emoji')
    assert.deepEqual(ensureDecoration(['你好'],'你好',{kind:'emoji',preset}),['你好⭐'])
    assert.equal(pickImageFallback(()=>0,c.localProfile.imageFallbackReplies),'私有读图兜底')
    rmSync(path.join(dir,'personas','示例甲.txt'));assert.throws(()=>config('existing'),/选定人格不存在/)
  })
  await test('私有拍一拍语料明确覆盖通用语料，损坏的私有风格不会当成公共默认',()=>{
    const file=path.join(root,'private-poke.txt');writeFileSync(file,'# 注释\n私有拍一拍{name}\n')
    assert.deepEqual(loadPokeReplies(repo,logger,file),['私有拍一拍{name}'])
    const dir=path.join(root,'invalid');mkdirSync(dir);writeFileSync(path.join(dir,'profile.local.json'),'[]')
    assert.throws(()=>readLocalProfile(dir),/必须为对象/)
  })
  console.log(`${passed} cases passed`)
} finally {
  assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('koukou-private-profiles-'))
  rmSync(root,{recursive:true,force:true})
}
