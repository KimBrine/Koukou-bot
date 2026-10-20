import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/memory.js'
import { createLongMemory } from '../src/longMemory.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'koukou-mem-edit-'))
const logger = { info() {}, warn() {}, error() {}, debug() {} }
try {
  // ---- 近期记忆：单条改 / 删 ----
  const file = path.join(root, 'memory.json')
  const mem = new MemoryStore({ file, limit: 20, logger })
  mem.load()
  mem.push('g1', 'user', '原来的内容', { time: Date.now() })
  mem.push('g1', 'assistant', '第二条', { time: Date.now() })
  mem.push('g1', 'user', '第三条', { time: Date.now() })
  assert.equal(mem.count('g1'), 3)

  const updated = mem.updateEntry('g1', 0, '改过的内容')
  assert.equal(updated.content, '改过的内容')
  assert.equal(mem.get('g1')[0].content, '改过的内容')
  assert.equal(mem.updateEntry('g1', 99, 'x'), null, '越界返回 null')
  assert.equal(mem.updateEntry('g1', 0, '   '), null, '空内容拒绝')
  assert.equal(mem.count('g1'), 3, '改内容不改条数')

  assert.equal(mem.removeEntry('g1', 1), true)
  assert.equal(mem.count('g1'), 2)
  assert.equal(mem.get('g1').some(m => m.content === '第二条'), false, '删掉的就是指定的那条')
  assert.equal(mem.removeEntry('g1', 9), false, '越界删除返回 false')

  // 落盘：重新加载后修改仍在
  const mem2 = new MemoryStore({ file, limit: 20, logger })
  mem2.load()
  assert.equal(mem2.count('g1'), 2)
  assert.equal(mem2.get('g1')[0].content, '改过的内容')

  // ---- 长期记忆：改摘要 / 删待整理 ----
  const longFile = path.join(root, 'long.json')
  const long = createLongMemory({ file: longFile, logger, llm: { chat: async () => 'x' } })
  long.addEvicted('g1', [
    { name: '甲', text: '第一条原文', time: Date.now() },
    { name: '乙', text: '第二条原文', time: Date.now() },
  ])
  assert.equal(long.detail('g1').pending.length >= 2, true)

  const saved = long.setSummary('g1', '手动写的长期记忆')
  assert.equal(saved.chars, '手动写的长期记忆'.length)
  assert.equal(long.detail('g1').summary, '手动写的长期记忆')
  assert.ok(long.detail('g1').updatedAt > 0)

  const before = long.detail('g1').pending.length
  assert.equal(long.removePending('g1', 0), true)
  assert.equal(long.detail('g1').pending.length, before - 1)
  assert.equal(long.removePending('g1', 99), false, '越界返回 false')
  assert.equal(long.detail('g1').pending[0].text, '第二条原文')

  // 落盘
  const long2 = createLongMemory({ file: longFile, logger, llm: { chat: async () => 'x' } })
  assert.equal(long2.detail('g1').summary, '手动写的长期记忆')
  assert.equal(long2.detail('g1').pending.length, 1)

  // 没有的会话也能写摘要
  assert.equal(long.setSummary('gX', '新会话摘要').chars, '新会话摘要'.length)
  assert.equal(long.detail('gX').summary, '新会话摘要')

  console.log('记忆单条编辑检查通过：改正文 / 删单条 / 越界保护 / 落盘 / 摘要改写 / 丢弃待整理。')
} finally {
  rmSync(root, { recursive: true, force: true })
}
