/**
 * 回复形态（长度自适应 + 多行分条）单元测试：不联网、不发消息。
 *   node scripts/test-reply-shape.mjs
 */
import {
  measureText,
  backlogLength,
  pickLineCount,
  planReply,
  shapeReply,
  shapeHint,
  decorationHint,
  pickDecorationKind,
  contentLength,
  ensureDecoration,
  trimTo,
} from '../src/replyShape.js'
import { decorationRe } from '../src/humanize.js'

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

console.log('\n=== 1. measureText：内部标记不算长度 ===')
ok('去掉【名字】前缀', measureText('【张三】你好呀') === 3, `→ ${measureText('【张三】你好呀')}`)
ok('去掉 [引用 …] 标记', measureText('[引用 李四：在吗] 在的') === 2, `→ ${measureText('[引用 李四：在吗] 在的')}`)
ok('QQ 表情按 1 个字算', measureText('[表情:笑哭]') === 1, `→ ${measureText('[表情:笑哭]')}`)
ok('去掉 [图片] 占位', measureText('[图片]') === 0, `→ ${measureText('[图片]')}`)
ok('去掉 @某人', measureText('@Koukou. 你说啥') === 3, `→ ${measureText('@Koukou. 你说啥')}`)
ok('普通文本原样计数', measureText('今天天气不错啊') === 7)

console.log('\n=== 2. backlogLength：未回消息的累计长度 ===')
const hist = [
  { role: 'assistant', content: '哦哦' },
  { role: 'user', content: '【A】第一条' },
  { role: 'user', content: '【B】第二条消息' },
]
ok('只数最后一段连续的 user 消息', backlogLength(hist) === 3 + 5, `→ ${backlogLength(hist)}`)
ok('最后一条是 assistant 时为 0', backlogLength([...hist, { role: 'assistant', content: 'x' }]) === 0)
ok('空历史为 0', backlogLength([]) === 0)
ok('超长时被 cap 截住', backlogLength([{ role: 'user', content: '字'.repeat(500) }], { cap: 100 }) === 100)

console.log('\n=== 3. pickLineCount：以一行 为主 ===')
ok('maxLines=1 时永远 1 行', pickLineCount(999, { maxLines: 1, rand: () => 0.99 }) === 1)
ok('短消息 + 随机值偏大 → 1 行', pickLineCount(25, { maxLines: 3, rand: () => 0.5 }) === 1)
ok('内容不足 16 字 → 绝不分行（「在吗」不该拆两条发）', pickLineCount(15, { maxLines: 3, rand: () => 0 }) === 1)
ok('内容不足 30 字 → 最多 2 行', pickLineCount(20, { maxLines: 3, rand: () => 0 }) === 2)
ok('长消息 + 极小随机值 → 3 行', pickLineCount(60, { maxLines: 3, rand: () => 0.001 }) === 3)
ok('长消息更容易分行', pickLineCount(120, { maxLines: 3, rand: () => 0.5 }) === 3, '120 字 @0.5 → 3 行')
ok('一行装得下的长度仍以单行为主', pickLineCount(35, { maxLines: 3, rand: () => 0.5 }) === 1, '35 字 @0.5 → 1 行')
ok('超过两行容量的长度几乎必然分行', pickLineCount(100, { maxLines: 3, rand: () => 0.9 }) === 2, '100 字 @0.9 → 2 行')
{
  // 统计 20 万次：短消息单行率应 >80%，长消息应几乎不单行
  let short1 = 0
  let long1 = 0
  const N = 200000
  for (let i = 0; i < N; i++) {
    if (pickLineCount(10) === 1) short1++
    if (pickLineCount(120) === 1) long1++
  }
  const r1 = (short1 / N) * 100
  const r2 = (long1 / N) * 100
  ok('短消息单行率 >80%', r1 > 80, `→ ${r1.toFixed(1)}%`)
  ok('长消息几乎不单行', r2 < 10, `→ ${r2.toFixed(1)}%`)
}

console.log('\n=== 4. planReply：预算跟着对方长度走 ===')
const shortPlan = planReply({ incomingLen: 5, maxLines: 3, lineMaxChars: 40, rand: () => 0.99 })
const longPlan = planReply({ incomingLen: 90, maxLines: 3, lineMaxChars: 40, rand: () => 0.99 })
ok('短消息预算小', shortPlan.budget <= 15, `→ ${shortPlan.budget} 字`)
ok('长消息预算更大', longPlan.budget > shortPlan.budget, `→ ${longPlan.budget} vs ${shortPlan.budget}`)
ok('预算不超过 行数×单行上限', longPlan.budget <= longPlan.lines * 40, `→ ${longPlan.budget} / ${longPlan.lines * 40}`)
ok('关闭自适应时固定单行', planReply({ incomingLen: 90, matchEnabled: false }).lines === 1)
{
  const multi = planReply({ incomingLen: 60, maxLines: 3, lineMaxChars: 40, rand: () => 0.001 })
  ok('3 行时的每行上限被压到预算内', multi.perLineCap <= 40 && multi.lines === 3, `→ 每行 ≤${multi.perLineCap}`)
}
ok('未回消息按 35% 折算进预算', planReply({ incomingLen: 0, backlogLen: 100, rand: () => 0.99 }).targetLen === 35)

console.log('\n=== 5. shapeReply：分行裁剪 ===')
const p1 = { lines: 1, budget: 40, perLineCap: 40, lineMaxChars: 40 }
ok('单行原样保留', JSON.stringify(shapeReply('好耶', p1)) === JSON.stringify(['好耶']))
ok('单行计划下多行被合并成一行', shapeReply('第一句\n第二句', p1).length === 1)
{
  const p3 = { lines: 3, budget: 120, perLineCap: 40, lineMaxChars: 40 }
  const out = shapeReply('第一句\n第二句\n第三句', p3)
  ok('三行原样分三条', out.length === 3, `→ ${JSON.stringify(out)}`)
  const merged = shapeReply('一\n二\n三\n四\n五', p3)
  ok('超过 3 行时并入最后一行（不丢内容）', merged.length === 3 && merged[2].includes('五'), `→ ${JSON.stringify(merged)}`)
  ok('去掉模型自加的编号/项目符号', JSON.stringify(shapeReply('1. 第一\n- 第二\n• 第三', p3)) === JSON.stringify(['第一', '第二', '第三']))
}
{
  // 总预算 30：第一行 18 字 + 第二行 40 字 → 第二行必须被压到 12 字左右
  const p = { lines: 2, budget: 30, perLineCap: 40, lineMaxChars: 40 }
  const out = shapeReply('这是第一行大概十八个字的内容哦\n这是第二行本来有四十个字的很长很长的一句话就这样', p)
  const total = out.join('').length
  ok('总字数被压进预算', total <= 30, `→ ${total} 字：${JSON.stringify(out)}`)
  ok('优先保住第一行', out[0].length >= out[1].length, `→ ${out[0].length} vs ${out[1].length}`)
}
{
  const p = { lines: 1, budget: 20, perLineCap: 20, lineMaxChars: 20 }
  const out = shapeReply('这真的是一句特别特别长的话，长到必须被裁掉后面那部分才行', p)
  ok('单行超长在句子边界裁断且不超限', out[0].length <= 20, `→ ${out[0]}（${out[0].length} 字）`)
}
ok('纯空白输入返回空数组', shapeReply('   \n  ', p1).length === 0)
{
  // 模型只给了一整行、但本次计划允许 2 行 → 自动拆条（而不是硬砍掉后半句）
  const p2 = { lines: 2, budget: 70, perLineCap: 35, lineMaxChars: 40 }
  const raw = '四十分钟辅助局真的太折磨人了，你队友全程挂机也是够离谱的，换我早就投了，真的服气'
  const out = shapeReply(raw, p2)
  ok('单行超长 + 计划多行 → 自动拆成多条', out.length === 2, `→ ${JSON.stringify(out)}`)
  ok('拆条后开头结尾内容都保住', out[0].includes('四十分钟辅助局') && out[1].includes('真的服气'))
  const single = shapeReply(raw, { ...p2, lines: 1, budget: 40, perLineCap: 40 })
  ok('计划只有 1 行时不会拆条', single.length === 1, `→ ${JSON.stringify(single)}`)
  const longSentences = '第一句结束了。第二句也结束了。第三句还是有点长的。第四句更长了哦。'
  const bySentence = shapeReply(longSentences, { lines: 3, budget: 90, perLineCap: 30, lineMaxChars: 40 })
  ok(
    '优先按句末标点拆（且段数不超上限）',
    bySentence.length > 1 && bySentence.length <= 3 && bySentence.every((s) => /[。！？]$/.test(s)),
    `→ ${JSON.stringify(bySentence)}`,
  )
}
{
  const out = shapeReply('[表情:doge]', { lines: 3, budget: 10, perLineCap: 8, lineMaxChars: 8 })
  ok('只有表情也保留（不会发出空消息）', out.length === 1 && out[0].length > 0, `→ ${JSON.stringify(out)}`)
  ok('预算极小时也不砍残表情标记', out[0] === '[表情:doge]', `→ ${JSON.stringify(out[0])}`)
}

console.log('\n=== 7. 表情标记安全：绝不发出 "[表情:dog…" 这种残片 ===')
{
  const hasBrokenFace = (t) => /\[表情[^\]]*$/.test(t)
  const cases = [
    ['[表情:doge]', 8],
    ['这是一句很长的话啊[表情:doge]后面还有很多字', 14],
    ['[表情:微笑]后面是很多很多的字', 8],
    ['好耶[表情:笑哭]', 5],
    ['啊啊啊啊啊啊啊[表情:流汗]这段真的好长好长', 10],
    ['[表情:害羞][表情:点赞]', 6],
  ]
  let bad = 0
  for (const [text, limit] of cases) {
    const out = trimTo(text, limit)
    if (hasBrokenFace(out)) {
      bad++
      console.log(`     残片：limit=${limit} → ${JSON.stringify(out)}`)
    }
  }
  ok('所有裁剪结果都不含残缺表情标记', bad === 0)
  ok('残缺输入也能被清掉', !hasBrokenFace(trimTo('好长的一句话[表情:dog', 6)))
}

console.log('\n=== 7b. 装饰符号安全：颜文字/emoji 绝不能被砍成半截 ===')
{
  // 回归：decorationRe 少传 u 标志时，\p{Extended_Pictographic} 会退化成字面字符集，
  // 把 p{}ExtendedPictographic 里的字母（含 a）当成装饰符号 —— "awa" 里的 a 会被误判，
  // 结果裁出 "好嘛，那我不吵你啦a…" 这种半截颜文字。
  const re = decorationRe('g')
  const matches = []
  let m
  while ((m = re.exec('好嘛，那我不吵你啦awa')) !== null) {
    matches.push(m[0])
    if (matches.length > 8) break
  }
  ok('awa 被整体识别（不是逐个字母）', matches.length === 1 && matches[0] === 'awa', `→ ${JSON.stringify(matches)}`)

  const cases = [
    ['好嘛，那我不吵你啦awa', 11],
    ['好嘛，那我不吵你啦awa', 10],
    ['我在呀awa', 6],
    ['好耶(=^▽^=)这个真不错啊', 9],
    ['啊啊啊好可爱(｡•́︿•̀｡)💦真的', 12],
    ['这种挂机狗就该原地消失！我上把也被坑，睡觉都在骂人QAQ', 20],
  ]
  const broken = []
  for (const [text, limit] of cases) {
    const out = trimTo(text, limit)
    // 残缺判据：出现了颜文字/emoji 的"前半截"，或结尾停在装饰符号内部
    const bad =
      /(?:a|q|Q|X|O|T|w)\s*…$/.test(out) ||
      /[（(][^）)]*…$/.test(out) ||
      /\[表情[^\]]*…$/.test(out) ||
      /[\p{Extended_Pictographic}]\uFE0F?…$/u.test(out)
    if (bad) broken.push(`${limit} → ${JSON.stringify(out)}`)
  }
  ok('裁剪后不会出现半截装饰', broken.length === 0, broken.length ? `\n     ${broken.join('\n     ')}` : '')
  ok('颜文字能完整保留（不被截断）', trimTo('好嘛，那我不吵你啦awa', 12) === '好嘛，那我不吵你啦awa')

  // 长度口径：装饰算 1 个字，普通字母不算装饰
  ok('装饰符号按 1 个字算', measureText('在的呀awa') === 4, `→ ${measureText('在的呀awa')}`)
  ok('颜文字整体算 1 个字', measureText('好耶(=^▽^=)') === 3, `→ ${measureText('好耶(=^▽^=)')}`)
  ok('英文单词不被当成装饰', measureText('OK好的') === 4, `→ ${measureText('OK好的')}`)
}

console.log('\n=== 7c. 装饰符号不占长度预算（"🍥 总是不出现"的结构性原因）===')
{
  const plan = { lines: 1, budget: 9, perLineCap: 9, lineMaxChars: 40 }
  const out = shapeReply('都是群里大家说的呀🍥', plan)
  ok('9 字预算下 🍥 没被裁掉', /🍥/u.test(out[0]), `→ ${JSON.stringify(out)}`)

  const out2 = shapeReply('宝宝我也喜欢你呀(=^▽^=)', { lines: 1, budget: 10, perLineCap: 10, lineMaxChars: 40 })
  ok('10 字预算下颜文字也没被裁掉', /\(=\^▽\^=\)/u.test(out2[0]), `→ ${JSON.stringify(out2)}`)

  const out3 = shapeReply('这是一句特别特别长的正文内容需要被裁掉一部分才行🍥', plan)
  ok('装饰免单不等于正文可以超长', contentLength(out3[0]) <= 9, `→ 正文 ${contentLength(out3[0])} 字：${JSON.stringify(out3)}`)
  // 正文被硬裁时句末的装饰会跟着没 → ensureDecoration 负责补回来
  ok('硬裁确实会弄丢装饰（所以需要兜底）', !/🍥/u.test(out3[0]), `→ ${JSON.stringify(out3)}`)
  const fixed = ensureDecoration(out3, '这是一句特别特别长的正文内容需要被裁掉一部分才行🍥', { kind: 'fishcake' })
  ok('ensureDecoration 把装饰补回来了', /🍥/u.test(fixed[0]), `→ ${JSON.stringify(fixed)}`)
  ok('模型没写装饰时按种类补（颜文字类）', /(=|awa|QAQ)/u.test(ensureDecoration(['正文'], '正文', { kind: 'kaomoji', rand: () => 0 })[0]))
  ok('多行时补在最后一行', /🍥/u.test(ensureDecoration(['第一行', '第二行'], '', { kind: 'fishcake' })[1]))

  // 不强绑定：模型自己带了装饰就不再插手（不会硬塞 🍥）
  const withKao = ensureDecoration(['在呀(=^▽^=)'], '在呀(=^▽^=)', { kind: 'fishcake' })
  ok('已有颜文字时不强塞 🍥', !/🍥/u.test(withKao[0]) && /\(=\^▽\^=\)/u.test(withKao[0]), `→ ${JSON.stringify(withKao)}`)
  const withOther = ensureDecoration(['好耶💦'], '好耶💦', { kind: 'fishcake' })
  ok('已有别的 emoji 时也不插手', !/🍥/u.test(withOther[0]), `→ ${JSON.stringify(withOther)}`)
  const both = ensureDecoration(['正文'], '', { kind: 'both', rand: () => 0 })
  ok('both 种类才同时补两种', /🍥/u.test(both[0]) && /\(=\^▽\^=\)/u.test(both[0]), `→ ${JSON.stringify(both)}`)

  // 种类分布：🍥 不被强绑定，两种各有出场机会
  const kinds = { fishcake: 0, kaomoji: 0, both: 0 }
  for (let i = 0; i < 10000; i++) kinds[pickDecorationKind()]++
  ok('种类按比例随机（不是只出 🍥）', kinds.fishcake > 3000 && kinds.kaomoji > 2500 && kinds.both > 1200, `→ ${JSON.stringify(kinds)}`)

  ok('contentLength 不把装饰算进正文', contentLength('好耶🍥(=^▽^=)') === 2, `→ ${contentLength('好耶🍥(=^▽^=)')}`)
}

console.log('\n=== 8. 标点安全：拆条/合并不产生「。，」这种连标点 ===')
{
  const mixed = [
    ['第一句结束了。第二句也结束了。第三句还是有点长的。第四句更长了哦。', { lines: 3, budget: 90, perLineCap: 30, lineMaxChars: 40 }],
    ['甲。乙。丙。丁。戊。', { lines: 2, budget: 60, perLineCap: 30, lineMaxChars: 40 }],
    ['长句一，长句二，长句三，长句四', { lines: 2, budget: 60, perLineCap: 30, lineMaxChars: 40 }],
  ]
  let bad = 0
  for (const [text, plan] of mixed) {
    const joined = shapeReply(text, plan).join('')
    if (/[。！？，、]{2,}/.test(joined)) {
      bad++
      console.log(`     连标点：${JSON.stringify(shapeReply(text, plan))}`)
    }
  }
  ok('拆条/合并后无连标点', bad === 0)
}

console.log('\n=== 6. trimTo / shapeHint ===')
ok('trimTo 不超限', trimTo('这句话需要被裁剪掉一部分内容才行', 8).length <= 8, `→ ${trimTo('这句话需要被裁剪掉一部分内容才行', 8)}`)
ok('trimTo 短文本原样', trimTo('短', 10) === '短')
ok('单行提示词说明字数预算', shapeHint(p1).includes('20') || shapeHint({ ...p1, budget: 20 }).includes('20'))
ok('多行提示词说明行数', shapeHint({ lines: 3, budget: 90, perLineCap: 30, lineMaxChars: 40, targetLen: 80 }).includes('3 行'))
ok('提示词要求不得提及（防止泄漏到聊天里）', shapeHint(p1).includes('不要提及'))

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
