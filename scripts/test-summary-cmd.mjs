const re = /^\/?(今日总结|每日总结|群总结|群聊总结)\s*(?:d\s*)?(\d{1,2})?\s*$/i

const cases = [
  '/群总结 d 3',
  '/群总结 3',
  '/群总结 d3',
  '群总结 d 7',
  '/群总结',
  '/今日总结',
  '/群总结 99',
  '/群总结 abc',
  '随便聊聊',
  '@机器人 /群总结 d 2',
]

for (const s of cases) {
  const m = s.match(re)
  if (m) {
    const raw = Number(m[2]) || 1
    const days = Math.max(1, Math.min(30, raw))
    console.log(`${JSON.stringify(s).padEnd(22)} ✅ 匹配 → 关键词=${m[1]} 原始数字=${m[2] ?? '(无)'} → 天数=${days}`)
  } else {
    console.log(`${JSON.stringify(s).padEnd(22)} ❌ 不匹配`)
  }
}
