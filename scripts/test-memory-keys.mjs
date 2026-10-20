import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/memory.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-keys-'))
const file = path.join(dir, 'memory.json')
const logger = { info() {}, warn() {} }
try {
  const m = new MemoryStore({ file, limit: 20, logger })
  m.load()
  m.get('g1046763308')
  assert.deepEqual(m.keys(), [], '只读不能创建会话键')
  assert.equal(m.count('g1046763308'), 0)
  m.push('g1046763308', 'user', '你好')
  assert.ok(m.keys().includes('g1046763308'), '写入后才有键')
  assert.equal(m.count('g1046763308'), 1)
  console.log('记忆键检查通过：只读不建键、写入才建键')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
