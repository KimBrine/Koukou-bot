// 离线：表情包必须同时带 subType（LLBot）和 sub_type（NapCat），否则会被当成普通图片
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bot = readFileSync(path.join(root, 'src', 'bot.js'), 'utf8')
const server = readFileSync(path.join(root, 'src', 'admin', 'server.js'), 'utf8')

let pass = 0
const check = (name, ok) => { assert.ok(ok, name); pass++; console.log('PASS', name) }

check('bot 发送表情包带 subType（LLBot 读驼峰）', /file,\s*sub_type:\s*1,\s*subType:\s*1/.test(bot))
check('控制台手动发表情包带 subType', /file,\s*sub_type:\s*1,\s*subType:\s*1/.test(server))
check('没有只带 sub_type 的残留发送', !/data:\s*\{\s*file,\s*sub_type:\s*1\s*\}/.test(bot) && !/data:\s*\{\s*file,\s*sub_type:\s*1\s*\}/.test(server))
console.log(`sticker segment checks passed: ${pass}`)
