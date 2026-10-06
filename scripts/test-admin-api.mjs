/**
 * 控制台 API 自测：把界面上会调的每个接口都真实打一遍。
 *   node scripts/test-admin-api.mjs [端口]
 *
 * 端口默认从当前配置读（BOT_ENV_FILE / ADMIN_PORT），**不要写死 8787** ——
 * 换号迁移后控制台可能已经是 8788，写死的话会打到早已退役的旧实例上，
 * 报一个让人摸不着头脑的 ECONNREFUSED。
 *
 * 会真的读写配置与人格文件，但每项测试后都会还原原值（say / summary / restart 这类有副作用的动作不测）。
 */
const { loadConfig } = await import('../src/config.js')
const PORT = Number(process.argv[2]) || loadConfig().adminPort || 8787
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${extra ? `　${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? `　${extra}` : ''}`)
  }
}

async function get(path) {
  const r = await fetch(BASE + path)
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON（比如首页 HTML） */
  }
  return { status: r.status, text, json }
}
async function post(action, body = {}) {
  const r = await fetch(`${BASE}/api/action/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json }
}

console.log(`=== 控制台 API 自测（${BASE}）===\n`)

console.log('— 只读接口 —')
const home = await get('/')
ok('首页返回 HTML', home.status === 200 && /Koukou 控制台/.test(home.text), `→ ${home.status}, ${home.text.length} 字节`)

const state = await get('/api/state')
ok('GET /api/state', state.status === 200 && state.json?.bot !== undefined)
ok('  含登录状态', typeof state.json?.bot?.connected === 'boolean', `→ 已连接=${state.json?.bot?.connected} 账号=${state.json?.bot?.nickname ?? '—'}`)
ok('  含 QQ 号与昵称', Boolean(state.json?.bot?.selfId), `→ ${state.json?.bot?.selfId}`)
ok('  含今日统计', state.json?.today?.date !== undefined, `→ ${state.json?.today?.total} 条`)
ok('  含看门狗信息（已删除该功能）', state.json?.watchdog === undefined, `→ watchdog=${state.json?.watchdog === undefined ? '已移除' : '仍存在'}`)

const chats = await get('/api/chats')
ok('GET /api/chats', chats.status === 200 && Array.isArray(chats.json?.items), `→ ${chats.json?.items?.length} 个会话`)
const g = chats.json?.items?.find((c) => c.type === 'group')
ok('  群会话带名字/人数/今日消息', Boolean(g) && g.id !== undefined, g ? `→ ${g.name}（${g.id}，${g.members ?? '?'} 人，今日 ${g.msgToday} 条）` : '')
ok('  会话带生效值（供界面显示"沿用全局"）', g?.effective?.proactiveRate !== undefined, g ? `→ 概率 ${(g.effective.proactiveRate * 100).toFixed(0)}%` : '')

const personas = await get('/api/personas')
ok('GET /api/personas', personas.status === 200 && Array.isArray(personas.json?.items), `→ ${personas.json?.items?.length} 个人格，当前「${personas.json?.active}」`)
ok('  当前人格被标记', personas.json?.items?.some((p) => p.active))

const cfg = await get('/api/config')
ok('GET /api/config', cfg.status === 200 && Array.isArray(cfg.json?.items), `→ ${cfg.json?.items?.length} 个可配置项`)
ok('  每项都标了即时生效/需重启', cfg.json?.items?.every((i) => typeof i.live === 'boolean'))

const logs = await get('/api/logs?lines=20')
ok('GET /api/logs', logs.status === 200 && Array.isArray(logs.json?.bot), `→ 机器人日志 ${logs.json?.bot?.length} 行，看门狗 ${logs.json?.watchdog?.length} 行`)

const mem = await get('/api/memory?key=' + encodeURIComponent(g?.key ?? 'g0'))
ok('GET /api/memory', mem.status === 200 && Array.isArray(mem.json?.items), `→ ${mem.json?.items?.length} 条`)

const daily = await get('/api/daily')
ok('GET /api/daily', daily.status === 200 && Array.isArray(daily.json?.items), `→ ${daily.json?.items?.length} 个数据文件`)

console.log('\n— 人格读写 —')
const p0 = await post('get-persona', { name: personas.json.active })
ok('读取人格内容', (p0.json?.content ?? '').length > 10, `→ ${(p0.json?.content ?? '').length} 字`)
const appendix = await post('get-appendix')
ok('读取系统附加说明', (appendix.json?.text ?? '').length > 100, `→ ${(appendix.json?.text ?? '').length} 字`)

const tmpName = `__自测人格_${Date.now()}`
const c1 = await post('create-persona', { name: tmpName, content: '你是自测用的临时人格。' })
ok('新建人格', c1.json?.ok === true)
const p1 = await get('/api/personas')
ok('  新人格出现在列表里', p1.json?.items?.some((x) => x.name === tmpName))
const act = await post('activate-persona', { name: tmpName })
ok('切换人格', act.json?.ok === true && act.json?.persona === '你是自测用的临时人格。', `→ 已切换`)
const st2 = await get('/api/state')
ok('  状态里当前人格已更新', st2.json?.config?.activePersona === tmpName, `→ ${st2.json?.config?.activePersona}`)
const back = await post('activate-persona', { name: personas.json.active })
ok('切换回原人格', back.json?.ok === true, `→ ${personas.json.active}`)
const dup = await post('create-persona', { name: tmpName, content: 'x' })
ok('重名人格被拒绝', dup.status !== 200 || dup.json?.error, `→ ${dup.json?.error ?? ''}`)
const del = await post('delete-persona', { name: tmpName })
ok('删除临时人格', del.json?.ok === true)
const p2 = await get('/api/personas')
ok('  已从列表消失', !p2.json?.items?.some((x) => x.name === tmpName))

console.log('\n— 会话设置读写 —')
const testKey = 'g999999999'
const s1 = await post('set-chat', { key: testKey, patch: { proactiveRate: 0.77, customPrompt: '自测专用要求', enabled: false } })
ok('保存会话设置', s1.json?.ok === true && s1.json?.settings?.proactiveRate === 0.77)
const chats2 = await get('/api/chats')
const saved = chats2.json?.items?.find((c) => c.key === testKey)
ok('  保存后能在列表里读到', saved?.raw?.proactiveRate === 0.77 && saved?.raw?.enabled === false, `→ 概率=${saved?.raw?.proactiveRate}`)
ok('  客制化 prompt 也存下了', saved?.raw?.customPrompt === '自测专用要求')
const s2 = await post('set-chat', { key: testKey, patch: { proactiveRate: null, enabled: true, customPrompt: '' } })
ok('  清空覆盖（回到沿用全局）', s2.json?.settings?.proactiveRate === null)
const s3 = await post('reset-chat', { key: testKey })
ok('重置会话设置', s3.json?.ok === true)
const chats3 = await get('/api/chats')
ok('  重置后不再有独立设置', chats3.json?.items?.find((c) => c.key === testKey)?.raw?.proactiveRate === undefined)

console.log('\n— 全局配置读写（改完还原）—')
const before = cfg.json.items.find((i) => i.key === 'EMOJI_KEEP_RATE')
const oldVal = before.effective
const set1 = await post('set-config', { key: 'EMOJI_KEEP_RATE', value: '0.42' })
ok('改配置项', set1.json?.ok === true, `→ 即时生效=${set1.json?.live}`)
const st3 = await get('/api/state')
ok('  立即生效（无需重启）', Math.abs(st3.json?.config?.emojiKeepRate - 0.42) < 1e-6, `→ ${st3.json?.config?.emojiKeepRate}`)
await post('set-config', { key: 'EMOJI_KEEP_RATE', value: oldVal })
const st4 = await get('/api/state')
ok('  已还原', Math.abs(st4.json?.config?.emojiKeepRate - Number(oldVal)) < 1e-6, `→ ${st4.json?.config?.emojiKeepRate}`)

const bad = await post('set-config', { key: '不存在的项', value: '1' })
ok('未知配置项被拒绝', Boolean(bad.json?.error), `→ ${bad.json?.error ?? ''}`)

const live = cfg.json.items.filter((i) => i.live).length
console.log(`\n  配置项共 ${cfg.json.items.length} 个，其中 ${live} 个即时生效、${cfg.json.items.length - live} 个需重启`)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
