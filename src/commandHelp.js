// 纯文字帮助：不调用模型、不生成合并记录；正常功能清单保持在单条消息预算内。
const GROUPS = [
  ['🧠 聊天与解题', ['question', 'music']],
  ['📝 群聊报告', ['summary']],
  ['🎈 轻松互动', ['request-sticker', 'request-poke', 'poke', 'auto-plus-one']],
  ['🛡 群聊管理', ['self-recall', 'self-mute', 'owner-mute', 'whole-mute', 'id-check', 'id-check-kick']],
  ['📌 帮助与记忆', ['help', 'clear-memory']],
]
const DETAILS = {
  question: ['/Q 题目或问题', '只对本轮认真讲解；支持题目图片。群里须明确@我，单独引用不触发。'],
  music: ['点歌 浮光 周深', '也可“点歌 歌曲ID / 完整链接”；默认网易云，QQ音乐请注明。'],
  summary: ['/群总结 [天数]', '省略天数总结今天，例如 /群总结 2 查看近两天。'],
  'request-sticker': ['给我发张表情包', '明确索图不抽自动配图概率，仍遵守图库开关、范围及冷却。'],
  'request-poke': ['拍一拍 @某人', '也能说“拍我”；支持昵称、引用和近期上下文选人。'],
  poke: ['拍机器人的头像', '收到真实拍一拍事件后回应。'],
  'auto-plus-one': ['连续两条相同文字（可夹QQ自带表情）', '仅白名单群；同一连续重复段只跟一次，不跟图片。'],
  'self-recall': ['引用目标消息，再@我说“帮我撤回”', '普通成员仅限本人消息；撤回他人消息需原有管理授权。'],
  'self-mute': ['禁言我 十分钟', '只能本人申请；不写时长默认1分钟，不足1分钟或超过30天不执行。'],
  'owner-mute': ['禁言 @某人 十分钟 / 解禁 @某人', '支持引用、上下文选人、批量和数学时长；仍核验管理身份。'],
  'whole-mute': ['开启全员禁言 / 关闭全员禁言', '需管理授权；暂不支持原生时段禁言。'],
  'id-check': ['/id_check', '核对群名片；仍须属于授权操作员。'],
  'id-check-kick': ['/id_check_kick', '按有效核对结果移出成员，仍核验操作员与群权限。'],
  help: ['/help', '查看当前会话可用的指令与互动。'],
  'clear-memory': ['/清除记忆 [全部]', '备份后重置记忆；“全部”会影响所有会话，请谨慎使用。'],
}
const oneLine = (v, max) => String(v || '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, max)

export function formatCommandHelp({ builtins = [], custom = [], isPrivate = false } = {}) {
  const blocks = ['📖 指令与互动指南\n仅列出当前会话已启用、符合范围与额外权限的功能。']
  const byId = new Map(builtins.map(c => [c.id, c])), seen = new Set()
  const entry = c => {
    const [example, note] = DETAILS[c.id] || [oneLine(c.trigger, 90), oneLine(c.description, 80)]
    return `• ${oneLine(c.name, 45)}${c.adminOnly ? '〔机器人管理员〕' : ''}\n  用法：${example}\n  ${note}`
  }
  for (const [title, ids] of GROUPS) {
    const commands = ids.map(id => byId.get(id)).filter(Boolean)
    if (!commands.length) continue
    commands.forEach(c => seen.add(c.id))
    blocks.push(title + '\n' + commands.map(entry).join('\n\n'))
  }
  const rest = builtins.filter(c => !seen.has(c.id))
  if (rest.length) blocks.push('🔧 其他功能\n' + rest.map(entry).join('\n\n'))
  const footer = ['💡 使用提示', isPrivate ? '私聊直接发送请求即可。' : '群里的文字请求请@我；拍头像、自动+1按各自事件触发。', '群管理操作另核验：群主，或同时担任本群管理员的机器人管理员；QQ权限与接口限制仍适用。'].join('\n')
  // 预留尾部提示，避免大量自定义规则把帮助拆成多条；不截断一条指令的说明。
  if (custom.length) {
    const lines = ['🧩 自定义指令']
    let shown = 0
    for (const c of custom) {
      const line = `• ${oneLine(c.name, 30)}${c.adminOnly ? '〔机器人管理员〕' : ''}\n  ${c.event === 'poke' ? '拍机器人头像' : oneLine(c.trigger, 65)}${c.responseMode === 'ai' ? '（AI回复）' : ''}`
      if ([...blocks, ...lines, line, footer].join('\n\n').length > 1650) break
      lines.push(line); shown++
    }
    if (shown < custom.length) lines.push(`另有${custom.length - shown}条自定义规则，可在控制台“指令中心”查看。`)
    blocks.push(lines.join('\n'))
  }
  blocks.push(footer)
  return blocks.join('\n\n')
}
