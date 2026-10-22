import { execFile } from 'node:child_process'
import path from 'node:path'

/** Only launch the bundled helper with argv; no shared scheduled task or fixed instance path. */
export async function openPathOnHost({rootDir,target,select=false,platform=process.platform,execFileImpl=execFile}) {
  if(platform!=='win32')throw new Error('仅Windows支持打开资源管理器，请复制路径在机器人所在电脑打开')
  const helper=path.join(rootDir,'scripts','open-path.vbs')
  await new Promise((resolve,reject)=>{
    execFileImpl('wscript.exe',['//B','//Nologo',helper,target,select?'select':'folder'],{windowsHide:true,timeout:8000},error=>error?reject(new Error('打开路径失败：'+error.message)):resolve())
  })
  return {ok:true,path:target,mode:select?'select':'folder',warning:'已请求在机器人所在电脑打开；若未出现窗口，请复制路径手动打开'}
}
