// 显式迁移旧人格文件到当前实例的私有人格库；不修改 .env，不自动激活，不覆盖已有文件。
// 设置好 BOT_ENV_FILE / BOT_DATA_DIR 后运行：node scripts/migrate-personas.mjs [--source=旧文件或目录]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, constants } from 'node:fs'
import path from 'node:path'
import { ROOT_DIR, PERSONA_DIR } from '../src/config.js'
const sourceArg = process.argv.find(a => a.startsWith('--source='))?.slice(9)
const source = sourceArg ? path.resolve(sourceArg) : path.join(ROOT_DIR, 'personas')
if (!existsSync(source)) throw new Error('未找到旧人格，请用 --source= 指定备份文件或目录')
const files = statSync(source).isDirectory() ? readdirSync(source).filter(f=>f.endsWith('.txt')).map(f=>path.join(source,f)) : [source]
mkdirSync(PERSONA_DIR, { recursive: true })
let copied=0, skipped=0
for (const file of files) {
  if (!readFileSync(file,'utf8').trim()) continue
  const dest=path.join(PERSONA_DIR,path.basename(file))
  if (existsSync(dest)) { skipped++; continue }
  copyFileSync(file,dest,constants.COPYFILE_EXCL);copied++
}
console.log(`已复制 ${copied} 个，跳过 ${skipped} 个已有文件；未改变当前选定人格。请在控制台选择并激活。`)
