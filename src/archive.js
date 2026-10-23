import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

/**
 * 打包：给 /发文件、Python 插件结果和 jm 打包共用。
 *
 * 格式 zip / 7z 由 7-Zip 生成（7z 也能写 zip）；没装 7-Zip 时 zip 退回
 * PowerShell 的 Compress-Archive。passes 是"压缩次数"：第 2 次起把上一次的
 * 压缩包再压一遍，得到 name.2.zip 这种嵌套包（次数可配 1~5，默认 1）。
 */
export const ARCHIVE_FORMATS = ['zip', '7z', 'rar']
const DEFAULT_7Z = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  'D:\\7-Zip\\7z.exe',
  '/usr/bin/7z',
  '/usr/bin/7zz',
  '/usr/local/bin/7z',
  '/opt/homebrew/bin/7z',
]

export function normalizeFormat(value) {
  const text = String(value || '').trim().toLowerCase()
  return ARCHIVE_FORMATS.includes(text) ? text : 'zip'
}

export function normalizePasses(value) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1
}

function findTool(preferred,candidates,names){
  const clean=String(preferred||'').trim().replace(/^"|"$/g,'')
  const list=[clean,...candidates,...(process.env.PATH||'').split(path.delimiter).flatMap(d=>names.map(n=>path.join(d,n)))].filter(Boolean)
  for(const item of list){try{if(statSync(item).isFile())return item;if(statSync(item).isDirectory())for(const n of names){const f=path.join(item,n);if(existsSync(f)&&statSync(f).isFile())return f}}catch{}}
  return ''
}
export function findSevenZip({sevenZipPath='',candidates=[]}={}){
 return findTool(sevenZipPath||process.env.SEVEN_ZIP_PATH,[...candidates,...DEFAULT_7Z],['7z.exe','7z','7zz'])
}
export function findRar(rarPath=''){
 return findTool(rarPath||process.env.RAR_PATH,['C:/Program Files/WinRAR/Rar.exe','C:/Program Files (x86)/WinRAR/Rar.exe'],['Rar.exe','rar'])
}

export function createArchive({ sevenZipPath = '', rarPath = '', candidates = [], logger = null, runImpl=run } = {}) {
  const exe = findSevenZip({sevenZipPath,candidates})
  const rar = findRar(rarPath)
  async function packOnce(sourcePath,outPath,format){
    const cwd=path.dirname(sourcePath), source=path.basename(sourcePath)
    let command,args
    if(format==='rar'){
      if(!rar)throw Error('没有找到 RAR 程序，请安装 WinRAR/RAR 并设置 RAR_PATH；7-Zip 不能创建 RAR')
      command=rar;args=['a','-ma5','-m5','-y','-idq',outPath,'--',source]
    }else if(exe){command=exe;args=['a','-t'+format,'-mx=9','-y',outPath,'--',source]}
    else if(format==='7z')throw Error('没有找到 7-Zip，请设置 SEVEN_ZIP_PATH')
    else if(process.platform==='win32'){
      command='powershell.exe';args=['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath '${sourcePath.replace(/'/g,"''")}' -DestinationPath '${outPath.replace(/'/g,"''")}' -Force`]
    }else{command='python3';args=['-m','zipfile','-c',outPath,sourcePath]}
    try{await runImpl(command,args,{cwd,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:2*1024*1024})}
    catch(e){throw Error('打包失败：'+String(e.stderr||e.message).slice(0,300))}
    if(!existsSync(outPath)||statSync(outPath).size===0)throw Error('压缩程序未生成有效文件')
  }

  /**
   * @returns {{file:string, name:string, dir:string, cleanup:()=>void, format:string, passes:number}}
   */
  async function pack(sourcePath, { format = 'zip', passes = 1, outDir = '' } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    if (!existsSync(source)) throw new Error('要打包的路径不存在：' + source)
    const fmt = normalizeFormat(format)
    const times = normalizePasses(passes)
    const dir = path.join(outDir || os.tmpdir(), 'koukou-archive-' + process.pid + '-' + randomUUID())
    mkdirSync(dir, { recursive: true })
    const base = path.basename(source).replace(/[\\/:*?"<>|]/g, '_')
    let current = source
    try { for (let round = 1; round <= times; round++) {
      const suffix = round === 1 ? '' : '.' + round
      const out = path.join(dir, `${base}${suffix}.${fmt}`)
      await packOnce(current, out, fmt)
      current = out
    }
    } catch(e){rmSync(dir,{recursive:true,force:true});throw e}
    return {
      file: current,
      name: path.basename(current),
      dir,
      format: fmt,
      passes: times,
      cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } },
    }
  }

  return { pack, sevenZipPath: exe, rarPath:rar, available: Boolean(exe) }
}

/** 打包失败时的友好说明（控制台/群里直接可读） */
export function archiveErrorHint(err) {
  const text = String(err?.message || err || '')
  if (/没有找到 7-Zip/.test(text)) return '这台机器没装 7-Zip，只能打 zip；要 7z 请安装 7-Zip 或设置 SEVEN_ZIP_PATH'
  return text
}
