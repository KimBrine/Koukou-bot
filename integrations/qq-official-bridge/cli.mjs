import { pathToFileURL } from 'node:url'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import { createOfficialBridge } from './bridge.mjs'

export function parseArguments(argv) {
  const options={enableQQ:false,port:8792}
  for(let index=0;index<argv.length;index++) {
    const name=argv[index]
    if(name==='--enable-qq'){options.enableQQ=true;continue}
    const key={'--credentials-file':'credentialsFile','--state-dir':'stateDir','--port':'port','--env-file':'envFile'}[name]
    if(!key||!argv[index+1]||argv[index+1].startsWith('--'))throw Error('参数无效：需要--credentials-file和--state-dir绝对私有路径')
    const value=argv[++index];options[key]=key==='port'?Number(value):value
  }
  if(!options.credentialsFile||!options.stateDir)throw Error('需要--credentials-file和--state-dir绝对私有路径')
  if(!Number.isInteger(options.port)||options.port<1024||options.port>65535)throw Error('端口必须在1024到65535之间')
  return options
}
export async function main(argv=process.argv.slice(2)) {
  const options=parseArguments(argv)
  let token=process.env.KOUKOU_QQ_BRIDGE_TOKEN
  if(options.envFile){
    if(!path.isAbsolute(options.envFile))throw Error('配置文件必须是绝对路径')
    const text=await readFile(options.envFile,'utf8')
    const rows=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>/^\s*(?:export\s+)?KOUKOU_QQ_BRIDGE_TOKEN\s*=/.test(line))
    if(rows.length!==1)throw Error('配置必须明确提供唯一桥接令牌')
    token=rows[0].slice(rows[0].indexOf('=')+1).trim()
    if(token.length>=2&&['"',"'"].includes(token[0])&&token.at(-1)===token[0])token=token.slice(1,-1)
  }
  const bridge=await createOfficialBridge({...options,token})
  await bridge.start()
  console.log('Koukou QQ official bridge: loopback transport ready; QQ is '+(bridge.status().binding.phase==='unbound'?'unbound':bridge.status().binding.phase))
  let closing=false
  const close=async()=>{if(closing)return;closing=true;await bridge.close()}
  process.once('SIGINT',close);process.once('SIGTERM',close)
  return bridge
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{console.error('官方QQ桥启动失败：请检查独立私有路径、配置、端口及桥接令牌；未输出凭据。');process.exitCode=1})
}
