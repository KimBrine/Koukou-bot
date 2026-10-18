// 只读取启动参数；进程操作使用 PowerShell 替身，不操作任何真实 QQ 或机器人进程。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const repo=fileURLToPath(new URL('..',import.meta.url)),rawRoot=mkdtempSync(path.join(os.tmpdir(),'koukou-launcher-')),root=realpathSync.native(rawRoot)
const envFile=path.join(root,'.env'),data=path.join(root,'data');mkdirSync(data)
const env={...process.env,BOT_ENV_FILE:envFile,BOT_DATA_DIR:data,BOT_PROFILE:'review'}
for(const k of ['PERSONA','ACTIVE_PERSONA','PERSONA_FILE','PERSONA_DIR','ONEBOT_WS_URL','ADMIN_PORT'])delete env[k]
try{
  writeFileSync(envFile,'ONEBOT_WS_URL=ws://127.0.0.1:3456\nADMIN_PORT=9876\nDEEPSEEK_API_KEY=not-for-output\n')
  const output=execFileSync(process.execPath,['scripts/launcher-settings.mjs'],{cwd:repo,env,encoding:'utf8'})
  assert.match(output,/ONEBOT_PORT=3456/);assert.match(output,/CONSOLE_PORT=9876/);assert.doesNotMatch(output,/not-for-output/)
  writeFileSync(envFile,'ONEBOT_WS_URL=ws://example.invalid:3456\n')
  assert.throws(()=>execFileSync(process.execPath,['scripts/launcher-settings.mjs'],{cwd:repo,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}),/本地 OneBot/)
  if(process.platform==='win32'){
    const script=path.join(root,'stop-old-bot.ps1');copyFileSync(path.join(repo,'stop-old-bot.ps1'),script)
    const startedAt=new Date().toISOString(),entry=path.join(root,'src','index.js')
    mkdirSync(path.dirname(entry));writeFileSync(entry,'// mock entry, never executed')
    writeFileSync(entry+'.bak','// unrelated entry, never executed')
    writeFileSync(path.join(data,'bot.lock'),JSON.stringify({pid:42,profile:'review',startedAt}))
    const quote=s=>"'"+s.replaceAll("'","''")+"'"
    const wrapper=`
      $global:stopCalled=$false
      function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) return ($env:MOCK_PROCESS | ConvertFrom-Json) }
      function Stop-Process { $global:stopCalled=$true }
      & ${quote(script)} -DryRun
      if ($global:stopCalled) { throw 'DryRun attempted to stop a process' }
    `
    const run=(commandLine,profile='review',date=startedAt)=>{
      writeFileSync(path.join(data,'bot.lock'),JSON.stringify({pid:42,profile,startedAt}))
      return execFileSync('powershell.exe',['-NoProfile','-Command',wrapper],{env:{...env,MOCK_PROCESS:JSON.stringify({Name:'node.exe',CommandLine:commandLine,CreationDate:date})},encoding:'utf8'})
    }
    assert.match(run(`node "${entry}" --profile=review`),/verified-instance pid=42/)
    assert.match(run(`node "${path.join(rawRoot,'src','index.js')}" --profile=review`),/verified-instance pid=42/)
    const shortRoot=execFileSync('powershell.exe',['-NoProfile','-Command',`(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${quote(root)}).ShortPath`],{encoding:'utf8'}).trim()
    assert.match(run(`node "${path.join(shortRoot,'src','index.js')}" --profile=review`),/verified-instance pid=42/)
    assert.doesNotMatch(run(`node "${entry}.bak" --profile=review`),/verified-instance/)
    assert.doesNotMatch(run('node C:\\unrelated\\server.js --profile=review'),/verified-instance/)
    assert.doesNotMatch(run(`node "${entry}" --profile=other`),/verified-instance/)
    assert.doesNotMatch(run(`node "${entry}" --profile=review`,'other'),/verified-instance/)
    assert.doesNotMatch(run(`node "${entry}" --profile=review`,'review','2020-01-01T00:00:00Z'),/verified-instance/)
  }
  console.log('PASS LLBot reads instance ports without secrets; cleanup validates lock/path/profile/start time using mocks.')
}finally{
  assert.equal(path.dirname(root),realpathSync.native(os.tmpdir()));assert.ok(path.basename(root).startsWith('koukou-launcher-'));rmSync(root,{recursive:true,force:true})
}
