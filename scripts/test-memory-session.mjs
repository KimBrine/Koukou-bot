import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/memory.js'
import { createLongMemory } from '../src/longMemory.js'
import { createChatSettings } from '../src/chatSettings.js'
import { loadSessionPersona, ADMIN_CLEAR_MEMORY_CMD_RE } from '../src/bot.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-mem-session-'))
const logger = { info() {}, warn() {}, debug() {}, error() {} }
try {
  // ---- 近期记忆：只清一个会话 ----
  const memFile = path.join(root, 'memory.json')
  const mem = new MemoryStore({ file: memFile, limit: 20, logger })
  mem.load()
  mem.push('g111', 'user', 'A 群发言', { time: Date.now() })
  mem.push('g111', 'assistant', 'A 群回复', { time: Date.now() })
  mem.push('g222', 'user', 'B 群发言', { time: Date.now() })
  assert.equal(mem.count('g111'), 2)
  assert.equal(mem.count('g222'), 1)
  assert.deepEqual(mem.keys().sort(), ['g111', 'g222'])
  assert.equal(mem.clearKey('g111'), 2, '返回清掉的条数')
  assert.equal(mem.count('g111'), 0)
  assert.equal(mem.count('g222'), 1, '别的会话不受影响')
  assert.equal(mem.clearKey('g999'), 0)

  // ---- 长期记忆：只清一个会话 ----
  const longFile = path.join(root, 'long-memory.json')
  const long = createLongMemory({ file: longFile, logger, llm: { chat: async () => 'x' } })
  long.addEvicted('g111', [{ name: 'A', text: '很久以前', time: Date.now() }])
  assert.ok(long.stats().some(s => s.key === 'g111'))
  assert.equal(long.clearKey('g111'), true)
  assert.equal(long.clearKey('g111'), false, '第二次返回 false')
  assert.equal(long.stats().filter(s => s.key === 'g111').length, 0)

  // ---- 会话级人设字段 ----
  const cs = createChatSettings({ file: path.join(root, 'chat-settings.json'), logger })
  cs.set('g111', { persona: '夜璃' })
  assert.equal(cs.get('g111').persona, '夜璃')
  assert.equal(cs.get('g222').persona, '', '未设置时跟随全局')
  assert.equal(cs.resolve('g111', { proactiveRate: 0.2 }).persona, '夜璃')
  cs.set('g111', { persona: '' })
  assert.equal(cs.get('g111').persona, '')

  // ---- 读取人格文件（按群指定的人格）----
  const personaDir = path.join(root, 'personas')
  mkdirSync(personaDir, { recursive: true })
  writeFileSync(path.join(personaDir, '测试人格.txt'), '你是测试用的人格。')
  const fakeConfig = { dataDir: root, personaDir }
  assert.equal(loadSessionPersona(fakeConfig, '测试人格'), '你是测试用的人格。')
  assert.equal(loadSessionPersona(fakeConfig, '不存在的人格'), '', '读不到时返回空串，退回全局')

  // ---- /清除记忆 指令识别 ----
  assert.ok(ADMIN_CLEAR_MEMORY_CMD_RE.test('/清除记忆'))
  assert.ok(ADMIN_CLEAR_MEMORY_CMD_RE.test('／清空记忆'))
  assert.ok(ADMIN_CLEAR_MEMORY_CMD_RE.test('/清除记忆 全部'))
  assert.ok(ADMIN_CLEAR_MEMORY_CMD_RE.test('/重置记忆 all'))
  assert.equal(ADMIN_CLEAR_MEMORY_CMD_RE.exec('/清除记忆 全部')[1], '全部')
  assert.ok(!ADMIN_CLEAR_MEMORY_CMD_RE.test('清除记忆'), '没有斜杠不算指令')
  assert.ok(!ADMIN_CLEAR_MEMORY_CMD_RE.test('我要清除记忆吗'))

  console.log('会话级记忆清除 / 按群人设 检查通过：约 25 组断言。')
} finally {
  rmSync(root, { recursive: true, force: true })
}
