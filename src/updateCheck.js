export const UPDATE_REPOSITORY = 'KimBrine/Koukou-bot'
const version = v => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(v || ''))?.slice(1).map(Number)
export function compareVersions(a,b) {
  const x=version(a),y=version(b)
  if(!x||!y)return null
  for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1
  return 0
}
/** 仅检查公开正式标签，不运行git、不读取凭据，也不自动安装。 */
export function createUpdateChecker({currentVersion,fetchImpl=fetch,now=Date.now}={}) {
  let cached=null,inflight=null,nextCheck=0
  const snapshot=()=>({...cached,currentVersion,repository:UPDATE_REPOSITORY})
  async function check({force=false}={}) {
    if(inflight)return inflight
    if(cached&&now()<nextCheck&&(!force||now()-(cached.checkedAt||0)<30000))return snapshot()
    inflight=(async()=>{
      try {
        const response=await fetchImpl(`https://api.github.com/repos/${UPDATE_REPOSITORY}/tags?per_page=100`,{headers:{accept:'application/vnd.github+json','user-agent':'Koukou-Studio-update-check'},signal:AbortSignal.timeout(8000)})
        if(!response.ok)throw Error(response.status===404?'仓库不可公开访问或不存在':response.status===403||response.status===429?'GitHub检查暂被限流，请稍后重试':'GitHub HTTP '+response.status)
        const tags=await response.json()
        if(!Array.isArray(tags))throw Error('GitHub返回格式异常')
        const stable=tags.map(t=>t.name).filter(t=>version(t)).sort((a,b)=>compareVersions(b,a))
        if(!stable.length)throw Error('未找到正式版本标签')
        const tag=stable[0],cmp=compareVersions(tag,currentVersion)
        if(cmp===null)throw Error('当前版本不是正式语义版本，无法比较')
        cached={status:cmp>0?'available':cmp<0?'ahead':'current',latestVersion:tag.replace(/^v/,''),checkedAt:now(),url:`https://github.com/${UPDATE_REPOSITORY}/tree/${encodeURIComponent(tag)}`,message:''}
        nextCheck=now()+6*60*60*1000
      }catch(error){cached={status:'error',checkedAt:now(),message:String(error.message||'更新检查失败').slice(0,180)};nextCheck=now()+15*60*1000}
      return snapshot()
    })()
    try{return await inflight}finally{inflight=null}
  }
  return {check}
}
