// Offline JS oracle fixtures; no QQ, model, web, private state or server startup.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { measureText, contentLength, backlogLength, planReply, shapeReply, shapeHint,
  decorationHint, ensureDecoration, pickDecorationKind } from '../src/replyShape.js'
import { hasDecoration, stripDecoration, looksLikeCodeOrMath, limitDecorationLines,
  createRateLimiter } from '../src/humanize.js'
import { modelHistory } from '../src/memory.js'
import { buildReplyFocus } from '../src/replyFocus.js'
import { CONVERSATION_RULES, CONTEXT_TACT_RULES } from '../src/conversationRules.js'

const texts = ['', '普通消息', 'hello English', '𠀀', '你好🍥', '很开心(=^▽^=)', '他说（明天）可以🍥',
  '[引用 某人]【甲】@乙 你好 [图片] (=^▽^=)', '[表情:笑哭]', 'x=2', '(x-2)(x-3)=0', 'a^2+b^2',
  '`if (a < b)`', '👨‍👩‍👦', '❤️', 'qwq', 'TAT', 'Orz', 'QAQ', '\ufe0f', '\u200d',
  '前半句。完整后半句不会丢失。', '- 第一行。\n2. 第二行。\n第3条：第三行。\n第四行。']
const plans = []
for (const incomingLen of [0, 2, 15, 16, 20, 21, 29, 30, 40, 41, 80, 81, 120, 200]) {
  for (const r of [0, .01, .1, .2, .5, .9, .99]) {
    for (const minBudget of [0, 50]) {
      plans.push({ incomingLen, backlogLen: 13, maxLines: 3, lineMaxChars: 40, minBudget, r })
    }
  }
}
plans.push({ incomingLen: 100, maxLines: 1, lineMaxChars: 60, matchEnabled: false, r: 0 })
const histories = [[], [
  { role: 'user', content: '我刚才说的是另一件事', senderName: '甲', userId: '101', time: 1800000000000 },
  { role: 'assistant', content: '【历史消息 时间未知】明白了。', replyToUserId: '101', replyToName: '甲' },
  { role: 'user', content: '继续', senderName: '乙】同学', userId: '102', time: 1800000001000, historical: true },
], [{ role: 'assistant', content: '上一句。' }, { role: 'user', content: '资料很长'.repeat(100), replyLength: 4 }, { role: 'user', content: '你好' }]]
const focusInput = { evt: { time: 1800000000, user_id: 101, message_id: 10 }, text: '再听我说说',
  senderName: '甲', quoted: { name: '机器人', text: '上一句明确的话' }, quoteFromBot: true,
  history: [{ role: 'user', userId: '101', content: '先前的问题', time: 1799999999000 },
    { role: 'assistant', replyToUserId: '101', content: '先前的回答', time: 1799999999500 },
    { role: 'user', userId: '102', content: '别人的更近问题', time: 1800000000000 }] }
const preset = { symbol: '🍥', kaomoji: ['(=^▽^=)'], weights: { emoji: .5, kaomoji: .3, both: .2 }, voiceHint: '' }
const normalizedPlan = p => ({ target_len: p.targetLen, lines: p.lines, budget: p.budget,
  per_line_cap: p.perLineCap, line_max_chars: p.lineMaxChars, long_mode: !!p.longMode })
const expected = {
  text: texts.map(t => ({ measure: measureText(t), content: contentLength(t), has: hasDecoration(t),
    strip: stripDecoration(t), math: looksLikeCodeOrMath(t) })),
  plans: plans.map(p => normalizedPlan(planReply({ ...p, rand: () => p.r }))),
  shapes: plans.slice(0, 50).map(p => texts.map(t => shapeReply(t, planReply({ ...p, rand: () => p.r })))),
  hints: plans.slice(0, 50).map(p => shapeHint(planReply({ ...p, rand: () => p.r }))),
  histories: histories.map(modelHistory), backlog: histories.map(h => backlogLength(h)),
  rules: [CONVERSATION_RULES, CONTEXT_TACT_RULES],
  focus: JSON.parse(buildReplyFocus(focusInput).marker.split('本轮定位数据 ')[1].slice(0, -1)),
  decorations: ['persona', 'emoji', 'kaomoji', 'both'].map(kind => ({
    hint: decorationHint(true, kind, preset), lines: ensureDecoration(['你好'], '', { kind, preset, rand: () => 0 }),
  })), kinds: [0, .5, .8, .99].map(r => pickDecorationKind(() => r, preset)),
}
const originalRandom = Math.random
try { Math.random = () => .9; expected.cleaned = limitDecorationLines(texts, 0) }
finally { Math.random = originalRandom }
const limiter = createRateLimiter({ perHour: 1, minGapMs: 4000 })
expected.rate = [limiter.check('g1', 1000000)]
limiter.record('g1', 1000000); limiter.touch('g1', 1001000)
expected.rate.push(limiter.check('g1', 1002000), limiter.check('g1', 1002000, { ignoreGap: true }),
  limiter.check('g1', 1005000, { perHourLimit: 2 }), limiter.check('g1', 4600000))

const pythonSource = String.raw`
import json, sys
from koukou.context import TABLES, model_history, build_reply_focus
from koukou.reply_shape import *
from koukou.rate_limit import RateLimiter
d=json.load(sys.stdin)
texts, plans, histories, f, preset = (d[k] for k in ['texts','plans','histories','focusInput','preset'])
def plan(p):
    aliases={'incomingLen':'incoming_len','backlogLen':'backlog_len','maxLines':'max_lines','lineMaxChars':'line_max_chars','minBudget':'min_budget','matchEnabled':'match_enabled'}
    return plan_reply(**{aliases[k]:v for k,v in p.items() if k in aliases}, rand=lambda:p['r'])
result={
 'text':[dict(measure=measure_text(t),content=content_length(t),has=has_decoration(t),strip=strip_decoration(t),math=looks_like_code_or_math(t)) for t in texts],
 'plans':[plan(p).as_dict() for p in plans],
 'shapes':[[shape_reply(t,plan(p)) for t in texts] for p in plans[:50]],
 'hints':[shape_hint(plan(p)) for p in plans[:50]],
 'histories':[model_history(h) for h in histories], 'backlog':[backlog_length(h) for h in histories],
 'rules':[TABLES['CONVERSATION_RULES'],TABLES['CONTEXT_TACT_RULES']],
 'focus':build_reply_focus(f['evt'],f['text'],f['senderName'],f['quoted'],f['quoteFromBot'],f['history'])['target'],
 'decorations':[dict(hint=decoration_hint(True,k,preset),lines=ensure_decoration(['你好'],'',kind=k,preset=preset,rand=lambda:0)) for k in ['persona','emoji','kaomoji','both']],
 'kinds':[pick_decoration_kind(lambda:r,preset) for r in [0,.5,.8,.99]],
 'cleaned':limit_decoration_lines(texts,0,rand=lambda:.9),
}
l=RateLimiter(per_hour=1,min_gap_ms=4000)
result['rate']=[l.check('g1',1000)]
l.record('g1',1000); l.touch('g1',1001)
result['rate'] += [l.check('g1',1002), l.check('g1',1002,ignore_gap=True),l.check('g1',1005,per_hour_limit=2),l.check('g1',4600)]
print(json.dumps(result,ensure_ascii=False))
`
const python = process.env.PYTHON || (existsSync(resolve('.venv/Scripts/python.exe'))
  ? resolve('.venv/Scripts/python.exe') : 'python3')
const run = spawnSync(python, ['-X', 'utf8', '-c', pythonSource], {
  input: JSON.stringify({ texts, plans, histories, focusInput, preset }), encoding: 'utf8',
  env: { ...process.env, PYTHONPATH: resolve('python') }, maxBuffer: 8 * 1024 * 1024,
})
assert.equal(run.status, 0, run.stderr || run.error?.message)
const actual = JSON.parse(run.stdout)
for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], key)
console.log(`Python reply/context parity passed: ${plans.length} plans, ${texts.length} text fixtures, history/focus/rules/decorations/rate limits.`)
