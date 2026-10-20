import {existsSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {writeJsonAtomic} from './stateFile.js'
export const personaGreetingHash=text=>createHash('sha256').update(String(text||'').trim()).digest('hex')
export function validateGreetingLibrary(value){
  const out={}
  for(const key of ['goodmorning','goodnight']){
    if(!Array.isArray(value?.[key])||value[key].length>24)throw Error('每种问候需为0～24段文字')
    out[key]=[...new Set(value[key].map(text=>{
      if(typeof text!=='string'||!text.trim()||text.trim().length>240||/\[CQ:/.test(text)||text.includes('\u0000'))throw Error('每段问候需为1～240字纯文字，不能包含CQ操作码')
      return text.trim()
    }))]
  }
  return out
}
/** 语库只按人格正文绑定，完全不调用模型；导出不含群号、回执或聊天记录。 */
export function createPersonaGreetingLibrary({file,logger}){
  let state={version:1,libraries:{}},blocked=false
  try{if(existsSync(file)){
    state=JSON.parse(readFileSync(file,'utf8'))
    if(state.version!==1||!state.libraries||Array.isArray(state.libraries))throw Error('语库格式错误')
    for(const [hash,value] of Object.entries(state.libraries)){
      if(!/^[a-f0-9]{64}$/.test(hash))throw Error('人格标识无效')
      state.libraries[hash]=validateGreetingLibrary(value)
    }
  }}catch(error){blocked=true;logger?.warn?.(`[早晚安语库] 无法读取，暂停使用：${error.message}`)}
  function get(content){return blocked?null:state.libraries[personaGreetingHash(content)]??null}
  function set(content,value){
    if(blocked)throw Error('语库文件损坏，请先恢复语库文件')
    if(!String(content||'').trim())throw Error('请先填写人格正文')
    const library=validateGreetingLibrary(value),hash=personaGreetingHash(content)
    const next={...state,libraries:{...state.libraries,[hash]:library}}
    writeJsonAtomic(file,next);state=next
    return library
  }
  function exportFor(content){const library=get(content);return library?{personaHash:personaGreetingHash(content),...library}:null}
  function validateImport(content,value){
    if(value?.personaHash!==personaGreetingHash(content))throw Error('语库与人格正文不匹配，不能混用')
    return validateGreetingLibrary(value)
  }
  return {get,set,exportFor,validateImport,isBlocked:()=>blocked}
}
