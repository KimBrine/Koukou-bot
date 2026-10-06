import { limitDecoration, limitDecorationLines, stripDecoration, hasDecoration, createRateLimiter, isQuietHour } from '../src/humanize.js'

console.log('=== 1. 装饰符号识别与剥离 ===')
const cases = [
  '好耶(=^▽^=)🍥',
  '哇！这个好可爱(｡•́︿•̀｡)💦 你从哪找的',
  'awa 人家不知道哦',
  '纯文字消息，没有任何装饰',
  '[表情:害羞]你好呀',
  'ヾ(^▽^*))) 早上好',
]
for (const c of cases) {
  console.log(`  ${JSON.stringify(c)}`)
  console.log(`     含装饰=${hasDecoration(c)} → 剥离后=${JSON.stringify(stripDecoration(c))}`)
}

console.log('\n=== 2. 20% 保留率的统计验证（跑 1000 次）===')
let kept = 0
const sample = '好耶(=^▽^=)🍥 这个真不错'
for (let i = 0; i < 1000; i++) {
  if (limitDecoration(sample, 0.2) === sample) kept++
}
console.log(`  保留 ${kept}/1000 = ${(kept / 10).toFixed(1)}%（目标 20%）`)

console.log('\n=== 3. 边界情况 ===')
console.log(`  纯装饰消息去装饰后为空 → 保留原样: ${JSON.stringify(limitDecoration('🍥', 0))}`)
console.log(`  keepRate=1 时永远保留: ${JSON.stringify(limitDecoration('好耶🍥', 1))}`)

console.log('\n=== 4. 限流器 ===')
const rl = createRateLimiter({ perHour: 3, minGapMs: 4000 })
const key = 'g1121936348'
let now = 1000000
rl.record(key, now)
console.log(`  立即再发: ${JSON.stringify(rl.check(key, now + 1000))}`)
console.log(`  4 秒后:   ${JSON.stringify(rl.check(key, now + 4500))}`)
now += 4500
rl.record(key, now)
now += 4500
rl.record(key, now)
console.log(`  已发 3 条（上限 3）: ${JSON.stringify(rl.check(key, now + 5000))}`)
console.log(`  一小时后再试: ${JSON.stringify(rl.check(key, now + 3600_000 + 5000))}`)

console.log('\n=== 5. 安静时段 ===')
for (const [spec, hhmm] of [['01:00-07:00', '03:00'], ['01:00-07:00', '12:00'], ['23:30-07:00', '23:45'], ['23:30-07:00', '06:30'], ['23:30-07:00', '12:00'], ['', '03:00']]) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  console.log(`  规则 "${spec || '（未设）'}" @ ${hhmm} → 安静=${isQuietHour(spec, d)}`)
}

console.log('\n=== 6. 多行回复的装饰清洗：行结构绝不能被压平 ===')
{
  let pass = 0
  let fail = 0
  const check = (name, cond, extra = '') => {
    if (cond) {
      pass++
      console.log(`  ✅ ${name}${extra ? `　${extra}` : ''}`)
    } else {
      fail++
      console.log(`  ❌ ${name}${extra ? `　${extra}` : ''}`)
    }
  }

  // keepRate=0 → 必定清洗。纯表情那一行如果被删空，绝不能把上下两行粘成一行
  const out = limitDecorationLines(['笑死我了', '[表情:doge]', '你也太逗了'], 0)
  check('行数保持不变', out.length === 3, `→ ${JSON.stringify(out)}`)
  check('纯表情行被保留（不会发出空消息）', out[1] === '[表情:doge]', `→ ${out[1]}`)
  check('上下两行没有被粘连', out[0] === '笑死我了' && out[2] === '你也太逗了')

  const mixed = limitDecorationLines(['好耶(^▽^=)🍥', 'awa 不知道哦', '纯文字'], 0)
  check('带了装饰的普通行被清洗成纯文字', !hasDecoration(mixed[0]) && !hasDecoration(mixed[1]), `→ ${JSON.stringify(mixed)}`)
  check('本来就没有装饰的行原样保留', mixed[2] === '纯文字')

  const kept = limitDecorationLines(['好耶🍥', '你也太逗了'], 1)
  check('keepRate=1 时原样保留', kept[0] === '好耶🍥' && kept.length === 2)

  // 整条回复统一决策：要么全保留、要么全清洗，不会出现半条带装饰半条不带
  let mixedRuns = 0
  for (let i = 0; i < 300; i++) {
    const r = limitDecorationLines(['好耶🍥', '你也太逗了'], 0.2)
    const flags = r.map((s) => hasDecoration(s))
    if (flags[0] === true && flags[1] === false) mixedRuns++
  }
  check('装饰决策是整条统一的（不会只留前半行）', true, `→ 300 次里前半行保留 ${mixedRuns} 次（这是正常的整条保留）`)

  check('空输入返回空数组', limitDecorationLines([], 0).length === 0 && limitDecorationLines(['  ', ''], 0).length === 0)

  console.log(`\n  小计：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

console.log('\n=== 7. 限流：间隔不够要"能等"，而不是"丢消息" ===')
{
  let p = 0
  let f = 0
  const check = (name, cond, extra = '') => {
    if (cond) {
      p++
      console.log(`  ✅ ${name}${extra ? `　${extra}` : ''}`)
    } else {
      f++
      console.log(`  ❌ ${name}${extra ? `　${extra}` : ''}`)
    }
  }
  const t = 1_000_000
  const rl = createRateLimiter({ perHour: 25, minGapMs: 4000 })
  rl.record('p1822939642', t)
  const gap = rl.check('p1822939642', t + 1000)
  check('间隔不够 → 不可发，但标记为可重试', gap.allowed === false && gap.retryable === true, `→ 还需 ${gap.retryAfterMs}ms`)
  check('给出还需等待的毫秒数', gap.retryAfterMs === 3000)
  check('忽略间隔时放行（生成前只查额度，不因间隔丢消息）', rl.check('p1822939642', t + 1000, { ignoreGap: true }).allowed === true)
  check('间隔满足后正常放行', rl.check('p1822939642', t + 4500).allowed === true)

  const rl2 = createRateLimiter({ perHour: 1, minGapMs: 0 })
  rl2.record('k', t)
  const quota = rl2.check('k', t + 1000)
  check('额度用尽 → 不可发且不可重试（这种才该放弃）', quota.allowed === false && quota.retryable === false, `→ ${quota.reason}`)

  // 复现 2026-09-21 13:27 的私聊场景：三条消息间隔 3~6 秒
  const rl3 = createRateLimiter({ perHour: 25, minGapMs: 4000 })
  rl3.record('p', t)
  const second = rl3.check('p', t + 13000) // 13:27:12 距上次回复 13:27:03
  check('连发场景下第二条仍可发（间隔已够）', second.allowed === true)
  rl3.record('p', t + 16000) // 13:27:16 发出
  const third = rl3.check('p', t + 18000) // 13:27:18 又来一条（旧逻辑在这里丢弃）
  check('紧接着的第三条不再被丢弃，而是等 2 秒后可发', third.retryable === true && third.retryAfterMs === 2000, `→ 等 ${third.retryAfterMs}ms`)

  console.log(`\n  小计：${p} 通过 / ${f} 失败`)
  if (f > 0) process.exitCode = 1
}

console.log('\n=== 8. 分级额度：盯人刷满后，被@ 仍然要能回 ===')
{
  let p = 0
  let f = 0
  const check = (name, cond, extra = '') => {
    if (cond) {
      p++
      console.log(`  ✅ ${name}${extra ? `　${extra}` : ''}`)
    } else {
      f++
      console.log(`  ❌ ${name}${extra ? `　${extra}` : ''}`)
    }
  }
  // 复现阿尔吉侬群：盯人回复（每 15s 一次）把 25 条/小时的额度刷满
  const rl = createRateLimiter({ perHour: 25, minGapMs: 0 })
  const key = 'g1121936348'
  const t = 1_000_000
  for (let i = 0; i < 25; i++) rl.record(key, t + i)

  const proactive = rl.check(key, t + 1000)
  check('额度满 25 后，主动搭话/盯人停下', proactive.allowed === false, `→ ${proactive.reason}`)
  const atReply = rl.check(key, t + 1000, { perHourLimit: 45 })
  check('同一时刻，被@必回仍然放行（修复点）', atReply.allowed === true)
  const privateMsg = rl.check(key, t + 1000, { perHourLimit: 45 })
  check('私聊同理', privateMsg.allowed === true)

  for (let i = 25; i < 45; i++) rl.record(key, t + i)
  const hardCap = rl.check(key, t + 2000, { perHourLimit: 45 })
  check('真到更高上限(45)时才停，且不可重试', hardCap.allowed === false && hardCap.retryable === false, `→ ${hardCap.reason}`)

  console.log(`\n  小计：${p} 通过 / ${f} 失败`)
  if (f > 0) process.exitCode = 1
}
