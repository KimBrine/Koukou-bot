import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/memory.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-keys-'))
const file = path.join(dir, 'memory.json')
const logger = { info() {}, warn() {} }
let m
try {
  m = new MemoryStore({ file, limit: 20, logger })
  m.load()
  m.get('g200000002')
  assert.deepEqual(m.keys(), [], '只读不能创建会话键')
  assert.equal(m.count('g200000002'), 0)
  m.push('g200000002', 'user', '你好')
  assert.ok(m.keys().includes('g200000002'), '写入后才有键')
  assert.equal(m.count('g200000002'), 1)
  console.log('记忆键检查通过：只读不建键、写入才建键')
} finally {
  if(m?.timer)clearTimeout(m.timer)
  rmSync(dir, { recursive: true, force: true })
}
