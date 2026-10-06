const ws = new WebSocket('ws://127.0.0.1:3001')
let seq = 0
const pending = new Map()
function call(action, params, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const echo = String(++seq)
    const t = setTimeout(() => { pending.delete(echo); reject(new Error('timeout')) }, timeout)
    pending.set(echo, { resolve, reject, t })
    ws.send(JSON.stringify({ action, params, echo }))
  })
}
ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data)
  if (d.echo !== undefined && pending.has(d.echo)) {
    const p = pending.get(d.echo)
    pending.delete(d.echo)
    clearTimeout(p.t)
    d.status === 'ok' ? p.resolve(d.data) : p.reject(new Error(d.message || d.retcode))
  }
}
ws.onopen = async () => {
  try {
    const list = await call('get_group_list', {})
    const groups = Array.isArray(list) ? list : list?.group_list || []
    console.log(`机器人当前在 ${groups.length} 个群里：`)
    for (const g of groups) {
      console.log(`  群号 ${g.group_id}  名称「${g.group_name}」  人数 ${g.member_count ?? '?'}`)
    }
    const whitelist = [200000019, 200000017, 200000018]
    console.log('\n=== 与白名单对比 ===')
    const ids = new Set(groups.map((g) => Number(g.group_id)))
    for (const id of whitelist) {
      console.log(`  ${id}: ${ids.has(id) ? '✅ 还在群里' : '❌ 已不在（被踢？）'}`)
    }
    console.log(`  200000001（待新增）: ${ids.has(200000001) ? '✅ 已在群里' : '❌ 不在群里'}`)
    process.exit(0)
  } catch (e) {
    console.error('ERR:', e.message)
    process.exit(1)
  }
}
setTimeout(() => process.exit(2), 60000)
