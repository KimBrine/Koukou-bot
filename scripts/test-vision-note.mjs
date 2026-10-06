/**
 * 图片分工与"分析报告"防护的单元测试（不需要模型、不联网）。
 *   node scripts/test-vision-note.mjs
 *
 * 背景：2026-09-23 22:20 群 200000002，群友发了张聊天记录截图，
 * 机器人回了「这是一段非常典型的**大学生QQ群…以下是对这段聊天记录及最后图片的详细解读：### 1. 核心事件：…」
 */
const {
  VISION_DESCRIBE_PROMPT,
  VISION_DESCRIBE_ASK,
  IMAGE_NOT_LOADED_NOTE,
  sanitizeImageDescription,
  buildImageContextNote,
  withImageContent,
  looksLikeReport,
  stripReportScaffold,
  IMAGE_FALLBACK_REPLIES,
  pickImageFallback,
} = await import('../src/visionNote.js')

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

console.log('\n=== 1. looksLikeReport：抓出真实闯祸的那段 ===')
const realIncident =
  '这是一段非常典型的**大学生QQ群（极大概率是大学班级群 对话内容充满了大学生群聊特有的“玩梗” ' +
  '以下是对这段聊天记录及最后图片的详细解读：### 1. 核心事件：【817 匹诺曹】'
ok('真事故原文判为报告', looksLikeReport(realIncident) === true)
ok('Markdown 标题判为报告', looksLikeReport('## 图片分析') === true)
ok('"以下是对…的解读"判为报告', looksLikeReport('以下是对这张图的解读') === true)
ok('"核心事件"判为报告', looksLikeReport('核心事件：有人在发图') === true)
ok('"详细解读"判为报告', looksLikeReport('给你一个详细解读') === true)

console.log('\n=== 2. looksLikeReport：正常群聊回复不能误伤 ===')
const normalReplies = [
  '宝宝这张图好好笑哦，人家笑死了(｡･ω･｡)',
  '诶嘿，你发这个是要给我看什么呀',
  '**好耶**，这表情包人家要了', // 带加粗但也只是普通回复
  '1. 你说得对 2. 但是我不听', // 有编号但没提聊天记录
  '呜哇，这张图信息量好大哦，人家慢慢看',
  '笑死，这不就是我吗',
  '🍥',
  '哈哈哈这个梗我知道，是那只猫对吧',
]
for (const r of normalReplies) ok(`不误伤: ${JSON.stringify(r.slice(0, 22))}`, looksLikeReport(r) === false)
ok('空字符串不算报告', looksLikeReport('') === false)
ok('null 不算报告', looksLikeReport(null) === false)

console.log('\n=== 3. stripReportScaffold：清掉发到群里很难看的 Markdown ===')
ok('成对加粗被还原', stripReportScaffold('**好耶**今天真不错') === '好耶今天真不错')
ok('落单的 ** 被清掉（模型经常只开不闭）', stripReportScaffold('这是一段非常典型的**大学生QQ群') === '这是一段非常典型的大学生QQ群')
ok('### 标题和编号都被清掉', stripReportScaffold('### 1. 核心事件') === '核心事件', `→ ${JSON.stringify(stripReportScaffold('### 1. 核心事件'))}`)
ok('行首列表符号被清掉', stripReportScaffold('- 第一点\n- 第二点') === '第一点\n第二点')
ok('行首编号被清掉', stripReportScaffold('1. 第一点\n2. 第二点') === '第一点\n第二点')
ok(
  '标题行不会把下一行粘上来（换行必须保留）',
  stripReportScaffold('### 标题\n正文在这里') === '标题\n正文在这里',
  `→ ${JSON.stringify(stripReportScaffold('### 标题\n正文在这里'))}`
)
ok(
  '列表行同样不粘行',
  stripReportScaffold('开头\n- 第一点\n- 第二点').split('\n').length === 3,
  `→ ${JSON.stringify(stripReportScaffold('开头\n- 第一点\n- 第二点'))}`
)
ok('代码块被清掉', !stripReportScaffold('看这个```js\nvar a=1\n```').includes('var a=1'))
ok('正常回复原样不动', stripReportScaffold('宝宝你好呀，人家刚睡醒捏') === '宝宝你好呀，人家刚睡醒捏')
ok('换行结构保留（分条发送依赖它）', stripReportScaffold('第一行\n第二行\n第三行').split('\n').length === 3)
ok('null 不崩', stripReportScaffold(null) === '')

console.log('\n=== 4. sanitizeImageDescription：读图结果要短、无文体 ===')
const messy =
  '```\n这是一张截图\n```\n### 图片分析\n\n**主要内容**：\n- 有人在聊天\n- 有人在发图\n1. 第一点\n2. 第二点\n\n\n   结论：很热闹'
const cleaned = sanitizeImageDescription(messy)
ok('没有 Markdown 标题残留', !cleaned.includes('#'))
ok('没有加粗残留', !cleaned.includes('*'))
ok('没有列表符号残留', !cleaned.includes('- ') && !cleaned.includes('1. '))
ok('换行被压成空格（单段）', !cleaned.includes('\n'))
ok('没有连续空格', !/ {2,}/.test(cleaned))
ok('内容是通的', cleaned.includes('有人在聊天'), `→ ${cleaned}`)
const long = sanitizeImageDescription('哇'.repeat(500))
ok('超长被截断到 160 字以内', [...long].length <= 161, `→ ${[...long].length}`)
ok('截断带省略号', long.endsWith('…'))
ok('emoji 截断不会切出半个字符（代理对安全）', !/[\uD800-\uDBFF]$/.test(sanitizeImageDescription('🍥'.repeat(300), { maxChars: 5 })))
ok('null 不崩', sanitizeImageDescription(null) === '')
ok('开头标点被清掉', sanitizeImageDescription('：一只猫') === '一只猫')
ok('可自定义上限', [...sanitizeImageDescription('一二三四五六七八九十', { maxChars: 3 })].length === 4)

console.log('\n=== 5. buildImageContextNote：备注里必须带"别复述" ===')
const note = buildImageContextNote('一只橘猫在键盘上睡觉')
ok('包含读图结果', note.includes('一只橘猫在键盘上睡觉'))
ok('明确说是内部备注', note.includes('内部备注'))
ok('明确禁止复述', note.includes('绝对不要照抄'))
ok('明确禁止描述画面', note.includes('不要逐条描述画面'))
ok('要求先回应图本身（别顺着历史话题跑）', note.includes('先针对图里的内容回应'), `→ ${note.includes('先针对图里的内容回应')}`)
ok('说明这是"当前这条消息"的图', note.includes('当前这条消息的图片内容'))
ok('以换行开头（接在系统提示词后面）', note.startsWith('\n\n'))

console.log('\n=== 6. 读图提示词本身要挡住分析文体 ===')
ok('提示词要求平实描述', VISION_DESCRIBE_PROMPT.includes('平实'))
ok('提示词禁止 Markdown', VISION_DESCRIBE_PROMPT.includes('不要 Markdown'))
ok('提示词禁止"以下是对…"文体', VISION_DESCRIBE_PROMPT.includes('以下是对'))
ok('提示词禁止逐条抄录聊天记录', VISION_DESCRIBE_PROMPT.includes('不要逐条抄录'))
ok('提示词有长度上限', VISION_DESCRIBE_PROMPT.includes('120 字'))
ok('引导语非空', VISION_DESCRIBE_ASK.length > 0)
ok('读图失败说明里给了"图没加载出来"的措辞', IMAGE_NOT_LOADED_NOTE.includes('图没加载出来'))
ok('读图失败说明会盖掉前一条（以【图片状态】开头）', IMAGE_NOT_LOADED_NOTE.includes('【图片状态】'))

console.log('\n=== 8. withImageContent：读图结果要进"本轮用户消息" ===')
ok('替换掉 [图片] 占位符', withImageContent('【714qc】[图片]', '一只猫') === '【714qc】[图片内容：一只猫]', `→ ${withImageContent('【714qc】[图片]', '一只猫')}`)
ok('带文字的消息也替换', withImageContent('【a】[图片]看这个', '一只猫') === '【a】[图片内容：一只猫]看这个')
ok('多个占位符都替换', withImageContent('a[图片]b[图片]', '猫') === 'a[图片内容：猫]b[图片内容：猫]')
ok('没有占位符时附在后面（不丢描述）', withImageContent('【a】', '一只猫') === '【a】（附带图片，画面内容：一只猫）', `→ ${withImageContent('【a】', '一只猫')}`)
ok('desc 为空时原样返回（记忆里存的仍是 [图片]）', withImageContent('【a】[图片]', '') === '【a】[图片]')
ok('desc 为 null 时原样返回', withImageContent('【a】[图片]', null) === '【a】[图片]')
ok('content 为空但图有描述 → 只输出图片描述（别丢）', withImageContent(null, '猫') === '（附带图片，画面内容：猫）', `→ ${withImageContent(null, '猫')}`)
ok('content 和 desc 都空 → 空串', withImageContent(null, '') === '')
ok('不会把描述写进"记忆格式"（这里只负责本轮消息拼接）', !withImageContent('【a】[图片]', '猫').includes('[图片]'))

console.log('\n=== 9. 兜底回应 ===')
ok('兜底语料非空', IMAGE_FALLBACK_REPLIES.length >= 3)
ok('兜底都是短句（<= 30 字）', IMAGE_FALLBACK_REPLIES.every((s) => [...s].length <= 30))
ok('兜底不含分析文体', IMAGE_FALLBACK_REPLIES.every((s) => !looksLikeReport(s)))
ok('rand=0 取第一条', pickImageFallback(() => 0) === IMAGE_FALLBACK_REPLIES[0])
ok('rand→1 不会越界', IMAGE_FALLBACK_REPLIES.includes(pickImageFallback(() => 0.999999)))
ok('rand 返回 1 也被夹住', IMAGE_FALLBACK_REPLIES.includes(pickImageFallback(() => 1)))
ok('1000 次都在语料里', Array.from({ length: 1000 }, () => pickImageFallback()).every((s) => IMAGE_FALLBACK_REPLIES.includes(s)))

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
