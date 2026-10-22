import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, lstatSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonAtomic } from './stateFile.js'

const ITEMS = ['memory.json', 'memory.json.reset.json', 'long-memory.json', 'long-memory.json.state.json',
  'long-memory.json.records', 'chat-settings.json', 'custom-commands.json', 'vision-providers.json',
  'command-center.json', 'supervisor-state.json', 'personas', 'stickers', 'persona.txt',
  'poke-replies.txt', 'persona-greetings.json']
const allowed = name => ITEMS.includes(name) || /^(?:memory|long-memory)__[^/\\<>:"|?*]+\.json$/.test(name)
const backupName = name => /^\d{8}-\d{6}(?:-[a-f0-9]{8})?$/.test(name)
function child(root, name) {
  const full = path.resolve(root, name)
  if (path.dirname(full) !== path.resolve(root)) throw Error('目录越界')
  return full
}
function safeTree(file) {
  const st = lstatSync(file)
  if (st.isSymbolicLink()) throw Error('备份不支持符号链接：' + path.basename(file))
  if (st.isDirectory()) for (const entry of readdirSync(file)) safeTree(path.join(file, entry))
}
const copy = (source, target) => { safeTree(source); cpSync(source, target, { recursive: true }) }

/** Complete backups have unique names; failed copies never replace a good backup. */
export function createBackup({ config, logger, now = () => Date.now() }) {
  const root = path.resolve(config.dataDir, 'backups')
  const pad = n => String(n).padStart(2, '0')
  function list() {
    if (!existsSync(root)) return []
    return readdirSync(root, {withFileTypes:true}).filter(e => e.isDirectory() && backupName(e.name)).map(e => {
      const dir = child(root, e.name)
      let size = 0
      const walk = file => { const st=lstatSync(file); if(st.isSymbolicLink())return; if(st.isDirectory())for(const n of readdirSync(file))walk(path.join(file,n)); else size+=st.size }
      walk(dir)
      let at = 0
      try { at = Number(JSON.parse(readFileSync(path.join(dir,'backup.json'),'utf8')).at) || 0 } catch {}
      return {name:e.name, dir, size, at}
    }).sort((a,b) => b.at-a.at || b.name.localeCompare(a.name))
  }
  function lastBackupAt() {
    const first=list()[0]
    if(!first)return 0
    if(first.at)return first.at
    const m=/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(first.name)
    return m?new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime():0
  }
  function run({reason='manual',keep=7}={}) {
    mkdirSync(root,{recursive:true})
    const d=new Date(now()),id=randomUUID()
    const name=''+d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'-'+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds())+'-'+id.slice(0,8)
    const temp=child(root,'.incomplete-'+id),dir=child(root,name)
    mkdirSync(temp)
    const items=[...new Set([...ITEMS,...readdirSync(config.dataDir).filter(allowed)])].filter(n=>existsSync(child(config.dataDir,n)))
    try {
      for(const item of items)copy(child(config.dataDir,item),child(temp,item))
      writeJsonAtomic(path.join(temp,'backup.json'),{version:2,at:now(),reason,items,persona:String(config.activePersona||'')})
      renameSync(temp,dir)
    } catch(err) { rmSync(temp,{recursive:true,force:true}); throw Error('备份未完成，未替换已有备份：'+err.message) }
    const all=list(),retain=Math.max(1,Math.floor(Number(keep)||7))
    for(const old of all.filter(x=>x.name!==name).slice(retain-1))rmSync(child(root,old.name),{recursive:true,force:true})
    logger?.info?.('[备份] 完成：'+name+'（'+items.length+' 项）')
    return {name,dir,copied:items.length}
  }
  function queueRestore(name) {
    if(!backupName(String(name)))throw Error('备份名称无效')
    const pending=path.join(config.dataDir,'restore-pending.json')
    if(existsSync(pending))throw Error('已有待还原任务，请先完成或处理该任务')
    const source=child(root,name);safeTree(source)
    const meta=JSON.parse(readFileSync(path.join(source,'backup.json'),'utf8'))
    if(meta.version!==2 || !Array.isArray(meta.items))throw Error('旧备份缺少完整性与人格信息，请手动核对后恢复')
    if(meta.persona!==String(config.activePersona||''))throw Error('请先切换到备份所用人格，再还原这份备份')
    const stageName='restore-'+randomUUID(),parent=path.join(config.dataDir,'config-backups'),stage=child(parent,stageName)
    mkdirSync(path.join(stage,'content'),{recursive:true})
    for(const item of meta.items){if(!allowed(item))throw Error('备份包含未知条目');copy(child(source,item),child(path.join(stage,'content'),item))}
    // Pin the selected copy before retention can prune it.
    const before=run({reason:'还原前自动备份'})
    writeJsonAtomic(pending,{version:1,phase:'queued',stage:stageName,items:meta.items,source:name,before:before.name,persona:meta.persona})
    return {ok:true,pending:true,restored:name,before:before.name}
  }
  return {run,list,lastBackupAt,queueRestore,root}
}

/** Only called after acquiring the instance lock and before loading mutable services. */
export function applyPendingRestore({config,logger}) {
  const pending=path.join(config.dataDir,'restore-pending.json')
  if(!existsSync(pending))return false
  const job=JSON.parse(readFileSync(pending,'utf8'))
  if(job.version!==1 || !/^restore-[a-f0-9-]{36}$/.test(job.stage) || !Array.isArray(job.items) || job.items.some(n=>!allowed(n)))throw Error('待还原任务格式错误')
  const stage=child(path.join(config.dataDir,'config-backups'),job.stage),rollback=path.join(stage,'rollback')
  const revert=()=>{for(const item of job.items){const dest=child(config.dataDir,item);rmSync(dest,{recursive:true,force:true});if(job.present.includes(item))copy(child(rollback,item),dest)}}
  if(job.phase==='applying'){if(!Array.isArray(job.present)||job.present.some(n=>!job.items.includes(n)))throw Error('还原回滚信息损坏');for(const item of job.present)safeTree(child(rollback,item));revert();job.phase='failed';writeJsonAtomic(pending,job);throw Error('上次还原中断，已回滚；请检查待还原任务')}
  if(job.persona!==String(config.activePersona||''))throw Error('待还原任务与当前人格不同，未修改数据')
  if(job.phase!=='queued')throw Error('待还原任务需要人工检查，未继续修改数据')
  for(const item of job.items)safeTree(child(path.join(stage,'content'),item))
  mkdirSync(rollback,{recursive:true});job.present=[]
  for(const item of job.items){const dest=child(config.dataDir,item);if(existsSync(dest)){copy(dest,child(rollback,item));job.present.push(item)}}
  job.phase='applying';writeJsonAtomic(pending,job)
  try {
    for(const item of job.items){const dest=child(config.dataDir,item);rmSync(dest,{recursive:true,force:true});copy(child(path.join(stage,'content'),item),dest)}
    job.phase='complete';writeJsonAtomic(path.join(stage,'result.json'),job);rmSync(pending)
    logger?.info?.('[备份] 启动前还原完成：'+job.source)
    return true
  } catch(err) {revert();job.phase='failed';writeJsonAtomic(pending,job);throw Error('还原失败，已回滚：'+err.message)}
}
