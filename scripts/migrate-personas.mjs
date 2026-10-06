/**
 * 一次性迁移：把根目录的 persona.txt 收进 personas/ 目录，并在 .env 里设 ACTIVE_PERSONA。
 * 之后控制台就能在多个「人格」之间切换、逐个编辑（人设文件不再只有一份）。
 *
 *   node scripts/migrate-personas.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const personaDir = path.join(ROOT, 'personas')
const legacy = path.join(ROOT, 'persona.txt')
const envFile = path.join(ROOT, '.env')

mkdirSync(personaDir, { recursive: true })
const existing = readdirSync(personaDir).filter((f) => f.endsWith('.txt'))

if (existing.length > 0) {
  console.log(`personas/ 里已有 ${existing.length} 个人格：${existing.join(', ')}`)
} else if (existsSync(legacy)) {
  const content = readFileSync(legacy, 'utf8')
  // 取人设里的角色名当文件名（第一行的「XXX」），取不到就用 default
  const name = /「([^」]{1,20})」/.exec(content)?.[1] ?? 'default'
  const target = path.join(personaDir, `${name}.txt`)
  copyFileSync(legacy, target)
  console.log(`已把 persona.txt 复制为 personas/${name}.txt（原文件保留作备份）`)

  let env = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  if (!/^\s*ACTIVE_PERSONA\s*=/m.test(env)) {
    env += `${env.endsWith('\n') || env === '' ? '' : '\n'}# 当前生效的人格（personas/<名字>.txt），控制台里可切换\nACTIVE_PERSONA=${name}\n`
    writeFileSync(envFile, env)
    console.log(`已在 .env 写入 ACTIVE_PERSONA=${name}`)
  } else {
    console.log('ACTIVE_PERSONA 已存在，未改动')
  }
} else {
  console.log('没有找到 persona.txt，也没有现成的人格文件，跳过迁移')
}

console.log('\n当前人格列表：')
for (const f of readdirSync(personaDir).filter((x) => x.endsWith('.txt'))) {
  const size = readFileSync(path.join(personaDir, f), 'utf8').length
  console.log(`  ${f}  (${size} 字)`)
}
