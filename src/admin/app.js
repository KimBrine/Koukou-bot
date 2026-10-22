const PAGES = [
  ['overview','◈  工作台'],
  ['chats','◎  会话管理'],
  ['commands','⌘  指令中心'],
  ['persona','✧  人格编辑'],
  ['humanize','◉  回复行为'],
  ['api','⌘  模型与接口'],
  ['report','▤  群聊报告'],
  ['memory','▤  记忆浏览'],
  ['stickers','☺  表情包'],
  ['metrics','▤  运行概览'],
  ['selfcheck','✓  自检'],
  ['errors','⚠  错误'],
  ['logs','≡  运行日志'],
]
let page = location.hash.replace('#','') || 'overview'
if (!PAGES.some(p => p[0] === page)) page = 'overview'
let state = null
const summaryRequests = new Set()
function summaryControls(groupId){return `<div class="summary-controls" data-summary-group="${Number(groupId)}" aria-label="群总结操作与进度"></div>`}
function summaryControlsHTML(groupId){
  const job=(state?.summaryProgress||[]).find(j=>Number(j.groupId)===Number(groupId))||{status:'idle'}
  const busy=summaryRequests.has(Number(groupId))||job.status==='generating'
  const status=job.status||'idle',terminal=['success','failed'].includes(status)
  const label=summaryRequests.has(Number(groupId))?'正在启动…':({idle:'空闲中',generating:'生成中',success:'生成成功',failed:'生成失败'}[status]||'空闲中')
  const time=terminal&&job.finishedAt?new Date(job.finishedAt).toLocaleString('zh-CN',{hour12:false}):''
  return `<button class="btn sm" data-summary-start="${Number(groupId)}" ${busy?'disabled':''} title="生成今天截至当前的群总结，完成后直接发送到本群">${busy?'正在生成…':'生成今日总结'}</button><span class="summary-state ${esc(status)}" role="status">${label}</span>${terminal?`<button class="summary-dismiss" data-summary-ack="${Number(groupId)}" data-job-id="${esc(job.jobId)}" aria-label="已阅读并关闭本群总结结果" title="已阅读，关闭此结果">×</button>`:''}<small class="summary-detail">${esc(job.message||'生成完成后会直接发送到本群。')}${time?' · '+esc(time):''}</small>`
}
function refreshSummaryControls(){
  document.querySelectorAll('[data-summary-group]').forEach(box=>{
    const groupId=Number(box.dataset.summaryGroup),html=summaryControlsHTML(groupId)
    if(box.dataset.summaryView===html)return
    box.innerHTML=html;box.dataset.summaryView=html
    box.querySelector('[data-summary-start]').onclick=()=>startGroupSummary(groupId)
    const ack=box.querySelector('[data-summary-ack]')
    if(ack)ack.onclick=async()=>{
      ack.disabled=true
      try{const r=await api('/api/action/summary-ack',{groupId,jobId:ack.dataset.jobId});state.summaryProgress=r.progress;refreshSummaryControls();if(!r.acknowledged)toast('任务状态已变化，请查看最新结果')}
      catch(e){toast(e.message,true);ack.disabled=false}
    }
  })
}
async function startGroupSummary(groupId){
  if(summaryRequests.has(groupId))return
  summaryRequests.add(groupId);refreshSummaryControls()
  try{
    const r=await api('/api/action/summary',{groupId,days:1})
    state.summaryProgress=r.progress||state.summaryProgress
    toast(r.busy?.includes(groupId)?'这个群已有总结正在生成，请查看旁边的进度':'已启动今日总结，完成后会发送到本群')
  }catch(e){toast('未能启动群总结：'+e.message,true)}
  finally{summaryRequests.delete(groupId);refreshSummaryControls()}
}
let updateInfo = null, updateChecking = false
let chats = []
let configItems = []
let personas = []
let activePersona = ''
let selectedPersona = ''
let openChats = new Set()
let logAuto = true
let logFilter = ''
let joinedGroups = []
let friendList = []
let memoryOverview = []
let memoryDetail = null
let memoryFold = { group: false, private: false }
let stickerCardOpen = new Set()
let apiCardsOpen = { model: false, vision: false, search: false }
let backupInfo = { items: [], root: '' }
let selfCheckInfo = null
let errorInfo = []
let pokeReplies = []
let pythonScripts = []
let pythonSettings = { recallSeconds: 300 }
let pythonDir = ''
let pyOpen = { card: false, rows: [], editors: [] }
let tasksInfo = null
let metricsInfo = []
let metricsRange = 7
let stickerFold = { rules: false, learn: false, manual: false, blacklist: false, similar: false, library: true }
let customCommands = []
let commandBuiltins = []
let pokeDiagnostics = {}
let modelsInfo = {}
let modelsAvailable = (function(){ try { return JSON.parse(localStorage.getItem('koukou_models') || '[]') } catch (e) { return [] } })()
let stickerPersona = null
let stickerList = []
let stickerBlacklist = []
let stickerScenes = []
let stickerLearned = 0
let webSearchInfo = null
let stickerLearn = {}
let stickerSettings = {}

const $ = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstElementChild }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const api = async (path, body) => {
  // 动作接口只接受 POST；没带 body 也自动按 POST + {} 发送，避免误发成 GET 变 404
  const action = typeof path === 'string' && path.startsWith('/api/action/')
  const opt = body !== undefined || action ? { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body ?? {}) } : {}
  const r = await fetch(path, opt)
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status))
  return j
}
function toast(msg, bad) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.style.borderLeftColor = bad ? 'var(--bad)' : 'var(--accent)'
  t.classList.add('show')
  clearTimeout(t._t)
  t._t = setTimeout(() => t.classList.remove('show'), bad ? 4200 : 2200)
}
function ask(title, description, button = '确认', textInput = false, defaultValue = '') {
  return new Promise(resolve => {
    const root = document.getElementById('modalRoot')
    root.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h2></h2><p></p>' +
      (textInput ? '<textarea id="modalInput" placeholder="输入要发送的内容"></textarea>' : '') +
      '<div class="row"><button class="btn" id="modalCancel">取消</button><button class="btn primary" id="modalOk"></button></div></div>'
    root.querySelector('h2').textContent = title
    root.querySelector('p').textContent = description
    root.querySelector('#modalOk').textContent = button
    const inputBox = root.querySelector('#modalInput')
    if (inputBox && defaultValue) inputBox.value = defaultValue
    root.classList.add('show')
    root.setAttribute('aria-hidden', 'false')
    const close = value => {
      root.classList.remove('show')
      root.setAttribute('aria-hidden', 'true')
      root.innerHTML = ''
      document.removeEventListener('keydown', onKey)
      resolve(value)
    }
    const onKey = ev => { if (ev.key === 'Escape') close(null) }
    document.addEventListener('keydown', onKey)
    root.onclick = ev => { if (ev.target === root) close(null) }
    root.querySelector('#modalCancel').onclick = () => close(null)
    root.querySelector('#modalOk').onclick = () => {
      const value = textInput ? root.querySelector('#modalInput').value.trim() : true
      if (textInput && !value) return
      close(value)
    }
    ;(root.querySelector('#modalInput') || root.querySelector('#modalOk')).focus()
  })
}
const fmtUptime = (s) => { const d=Math.floor(s/86400), h=Math.floor(s%86400/3600), m=Math.floor(s%3600/60); return (d?d+'天':'')+(h?h+'小时':'')+m+'分' }
const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString('zh-CN',{hour12:false}) : '—'

// ── 导航 ───────────────────────────────────────────────
function renderNav(){
  const nav = document.getElementById('nav')
  nav.innerHTML = ''
  PAGES.forEach(([id,label]) => {
    const b = $('<button>' + label + '</button>')
    if (id === page) b.classList.add('on')
    b.onclick = () => { page = id; location.hash = id; renderNav(); render() }
    nav.appendChild(b)
  })
}

// ── 页面：总览 ──────────────────────────────────────────
function accountStatusText(b = {}) {
  if (b.online === true) return '机器人在线'
  if (b.qqOnline === false) return 'QQ 已离线'
  if (b.qqGood === false) return 'QQ 服务异常'
  if (b.statusError === '控制台未响应') return '控制台未响应'
  if (!b.onebotConnected) return 'OneBot 未连接'
  if (b.reportedOnline === true) return b.statusError ? 'QQ 连接异常（待核验）' : 'QQ 连接核验中'
  return 'QQ 状态未确认'
}
function updateSideStatus(b = {}) {
  const dot = document.getElementById('sideDot')
  const label = document.getElementById('sideStatus')
  if (dot) dot.className = 'dot ' + (b.online === true ? 'ok' : 'bad')
  if (label) label.textContent = accountStatusText(b) + (b.selfId ? ' · ' + b.selfId : '')
}
function updateStatusText(){
  const u=updateInfo;if(!u)return '尚未检查';
  if(u.status==='available')return '发现新版 v'+u.latestVersion;
  if(u.status==='current')return '已是最新正式版本';
  if(u.status==='ahead')return '当前版本高于已发布标签';
  return '检查失败：'+(u.message||'请稍后重试');
}
function paintUpdates(){
  const u=updateInfo,n=document.getElementById('updateNotice');
  if(n){n.hidden=!u;n.innerHTML=u?'<small>当前 v'+esc(u.currentVersion||'未知')+'</small>'+(u.status==='available'?'<a href="'+esc(u.url)+'" target="_blank" rel="noopener noreferrer">发现新版 v'+esc(u.latestVersion)+' · 查看新版</a>':''):''}
  const status=document.getElementById('versionStatus');if(status)status.textContent=updateStatusText();
  const current=document.getElementById('currentVersion');if(current)current.textContent='v'+(u?.currentVersion||state?.version||'读取中');
  const checked=document.getElementById('versionChecked');if(checked)checked.textContent=u?.checkedAt?'上次检查：'+new Date(u.checkedAt).toLocaleString():'';
  const link=document.getElementById('versionLink');if(link){link.hidden=u?.status!=='available';if(u?.url)link.href=u.url}
}
async function refreshUpdates(force=false){
  if(updateChecking)return
  updateChecking=true
  const button=document.getElementById('checkUpdate')
  const status=document.getElementById('versionStatus')
  if(button){button.disabled=true;button.textContent='检查中…'}
  if(force&&status)status.textContent='正在检查…'
  if(force)toast('正在检查更新…')
  try{
    const timeout=new Promise(function(_,reject){setTimeout(function(){reject(new Error('检查超时（网络不通）'))},25000)})
    updateInfo=await Promise.race([api(force?'/api/action/check-update':'/api/updates',force?{}:undefined),timeout])
  }catch(e){updateInfo={...updateInfo,status:'error',message:e.message}}
  finally{
    updateChecking=false
    if(button){button.disabled=false;button.textContent='检查更新'}
    paintUpdates()
    if(force)toast(updateStatusText())
  }
}
function versionCard(){
  const ver = updateInfo?.currentVersion || state?.version || ''
  const checked = updateInfo?.checkedAt ? ('上次检查 ' + new Date(updateInfo.checkedAt).toLocaleTimeString('zh-CN',{hour12:false})) : ''
  return '<section class="card version-card"><div class="version-row">' +
    '<div class="version-main"><span class="badge">当前版本</span> <strong id="currentVersion">v' + esc(ver || '读取中') + '</strong> <span id="versionStatus" class="version-status">' + esc(updateStatusText()) + '</span></div>' +
    '<div class="version-actions"><button class="btn sm" id="checkUpdate">检查更新</button><a class="btn sm primary" id="versionLink" href="' + esc(updateInfo?.url || 'https://github.com/KimBrine/Koukou-bot/tags') + '" target="_blank" rel="noopener noreferrer"' + (updateInfo?.status === 'available' ? '' : ' hidden') + '>查看新版</a></div>' +
    '</div><div class="version-foot"><span id="versionChecked" class="mut">' + esc(checked) + '</span><details class="version-help"><summary>更新说明</summary><p class="mut">自动检查 GitHub 正式标签（最多 100 个），缓存 6 小时；手动检查间隔至少 30 秒。检查失败不代表已是最新。更新前请备份私有配置与数据；这里不会自动安装。</p></details></div></section>'
}

function overviewCards(){
  const b = state?.bot ?? {}
  const c = state?.counters ?? {}
  const t = state?.today ?? {}
  const dot = (ok) => '<span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>'
  const cards = [
    ['OneBot 连接', (b.onebotConnected ? dot(true) + ' 已连接' : dot(false) + ' 未连接'), b.onebotUrl],
    ['QQ 账号', dot(b.online === true) + ' ' + accountStatusText(b), esc(b.nickname || '') + (b.selfId ? (' · QQ ' + b.selfId) : '') + (b.probeCheckedAt ? (' · ' + new Date(b.probeCheckedAt).toLocaleTimeString('zh-CN',{hour12:false}) + ' 实际连接核验') : '') + (b.statusError ? ' · ' + esc(b.statusError) : '')],
    ['NapCat 服务端口', b.napcatPort ? (dot(true) + ' 已监听') : (dot(false) + ' 未开放'), '端口 ' + (b.napcatPortNumber || '—')],
    ['对话模型', esc(b.model || '—'), b.webSearch ? '联网搜索已启用' : '联网搜索未启用'],
    ['视觉模型', b.visionModel ? esc(b.visionModel) : '未启用', b.visionModel ? '带图消息自动识图' : '未配置视觉 API Key'],
    ['已运行', fmtUptime(state?.uptimeSec || 0), 'PID ' + (state?.pid ?? '—')],
    ['今日已记录消息', (t.total ?? 0) + ' 条', '自本次启动：收到 ' + (c.received||0) + ' / 回复 ' + (c.replied||0)],
  ]
  return '<div class="grid g3" id="kpiGrid">' + cards.map(([k,v,s]) => '<div class="card"><h3>' + k + '</h3><div class="kpi">' + v + '</div><div class="note">' + (s || '') + '</div></div>').join('') + '</div>'
}
function overviewTodayRows(){
  const t = state?.today ?? {}
  return (t.perGroup || []).map(g => {
    const chat = chats.find(x => String(x.id) === String(g.groupId))
    return '<tr><td>' + esc(chat?.name || ('群 ' + g.groupId)) + '</td><td class="mut">' + g.groupId + '</td><td>' + g.count + '</td></tr>'
  }).join('') || '<tr><td colspan="3" class="mut">今天还没有记录到消息</td></tr>'
}
function pageOverview(){
  const b = state?.bot ?? {}
  const dot = (ok) => '<span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>'
  const quickCard = [
    '<section class="card" style="margin-bottom:18px"><h2>常用开关</h2>',
    '<div class="note"><b>/Q 解题模式（单次启用）</b><br>私聊发送 /Q 问题，或在群里 @机器人 并带 /Q。认真讲解过程，支持题目图片；下一条未带 /Q 的消息恢复普通聊天。</div>',
    '<div style="display:flex;align-items:center;gap:12px;margin:10px 0">',
      '<label class="switch"><input type="checkbox" id="quickTiming"' + (configFlag('REPLY_TIMING_ENABLED') ? ' checked' : '') + '><i></i></label>',
      '<div><b>显示思考耗时</b><div class="mut" style="font-size:12px">仅 /Q 解题回复末尾附「（想了 X.X 秒）」；普通聊天不显示</div></div>',
    '</div>',
    '<div style="display:flex;align-items:center;gap:12px;margin:10px 0">',
    '<div><b>识图模型</b><div class="mut" style="font-size:12px">聊天里发图片时用哪个模型看</div></div>',
    '<select id="quickVision" style="margin-left:auto">',
    '<option value="deepseek"' + (state?.config?.visionProvider === 'deepseek' ? ' selected' : '') + '>DeepSeek</option>',
    '<option value="dashscope"' + (state?.config?.visionProvider === 'dashscope' ? ' selected' : '') + '>通义千问（准）</option>',
    (state?.config?.visionProviders||[]).map(x=>'<option value="custom:'+esc(x.id)+'"'+(state?.config?.visionProvider==='custom:'+x.id?' selected':'')+'>'+esc(x.name)+'</option>').join(''),
    '</select>',
    '</div>',
    '<div class="mut" style="margin-top:8px;font-size:12px">开关状态实时显示，改完立刻生效，不用重启</div>',
    '</section>'
  ].join('')
  const admins = (state?.config?.adminUsers || [])
  const adminCard = [
    '<section class="card" style="margin-bottom:18px"><h2>管理员（最高权限）</h2>',
    '<div class="note">配置群总结与清除记忆等指令的管理员 QQ 号，逗号分隔，保存后立即生效。/help 人人可用；清除记忆要求显式管理员授权。id_check 还需符合对应群与操作员规则。</div>',
    '<div class="flexbar"><input type="text" id="adminUsersInput" style="flex:1" placeholder="例如：200000011,200000012" value="' + esc(admins.join(',')) + '">',
    '<button class="btn primary" id="adminUsersSave">保存管理员</button></div>',
    '<div class="mut" style="margin-top:8px">当前管理员：' + (admins.length ? admins.map(esc).join('、') : '未配置（群总结等沿用公开范围；清除记忆须显式配置管理员）') + '</div>',
    '</section>'
  ].join('')
  return '<div class="hero"><span class="hero-status" id="heroStatus">' + dot(b.online === true) + ' ' + accountStatusText(b) + '</span>' +
    '<h1>机器人工作台</h1><div class="sub"><span id="updatedAt">' + new Date().toLocaleTimeString('zh-CN',{hour12:false}) + '</span> 更新 · 集中管理运行状态与操作</div></div>' +
    overviewCards() +
    '<div class="section-head"><h2>常用操作</h2><span class="note">操作作用于当前机器人</span></div>' +
    '<div class="card"><div class="toolgroup"><button class="btn primary" data-act="poke-target">检查盯人目标</button>' +
      '<button class="btn" data-act="summary">生成群聊报告</button>' +
      '<button class="btn" data-act="clear-alert">清除掉线提醒</button></div>' +
    '<details class="advanced-box"><summary>维护与定时指令</summary><div class="toolgroup advanced"><button class="btn" data-act="restart-bot">重启机器人</button>' +
      '<button class="btn" data-act="restart-napcat">重启 NapCat</button>' +
      '<button class="btn" data-act="daily-ping">立即发定时指令 (@示例机器人)</button></div></details></div>' +
    quickCard +
    adminCard +
    '<details class="card"><summary><b class="api-card-title">今日各群已记录消息</b> <span class="api-card-meta">本地记录</span></summary><div class="api-card-body"><table class="tbl"><thead><tr><th>群</th><th>群号</th><th>条数</th></tr></thead><tbody id="todayGroups">' + overviewTodayRows() + '</tbody></table></div></details>' +
    versionCard()
}
function proactiveSettingsPatch(box){
  const enabled=box.querySelector('[data-f="proactiveEnabled"]')
  if(!enabled)return {}
  const rate=box.querySelector('[data-f="proactiveRate"]')
  return {proactiveEnabled:enabled.checked,proactiveRate:box.querySelector('[data-global="proactiveRate"]')?.checked?null:Number(rate.value)}
}
function chatRow(c){
  const r = c.raw || {}, e = c.effective || {}
  const open = openChats.has(c.key) ? ' open' : ''
  const override = (k) => r[k] !== null && r[k] !== undefined && r[k] !== '' ? ' <span class="badge live">已单独设置</span>' : ''
  const groupRate = c.type === 'group' ? (state?.config?.proactiveRatePerGroup || []).find(x => Number(x.groupId) === Number(c.id)) : null
  const defaultRate = groupRate ? Number(groupRate.rate) : Number(state?.config?.proactiveRate ?? 0)
  const rateOrigin = groupRate ? '沿用群默认' : '沿用全局'
  const rateVal = r.proactiveRate === null || r.proactiveRate === undefined ? e.proactiveRate : r.proactiveRate
  const emojiVal = r.emojiKeepRate === null || r.emojiKeepRate === undefined ? e.emojiKeepRate : r.emojiKeepRate
  const linesVal = r.replyMaxLines ?? e.replyMaxLines
  const charsVal = r.lineMaxChars ?? e.lineMaxChars
  const quietVal = r.quietHours === null || r.quietHours === undefined ? (e.quietHours||'') : r.quietHours
  return `
  <div class="chat${open}" data-key="${c.key}">
    <div class="head">
      <span class="badge">${c.type === 'group' ? '群' : '私聊'}</span>
      <span class="name">${esc(c.name)}</span>
      <span class="mut">${c.id}</span>
      ${c.inWhitelist ? '<span class="badge whitelist">白名单</span>' : ''}
      ${r.enabled === false ? '<span class="badge restart">已停用</span>' : ''}
      ${c.type === 'group' && r.proactiveEnabled === false ? '<span class="badge restart">不主动</span>' : ''}
      <span style="flex:1"></span>
      <span class="mut" style="font-size:12px">今日 ${c.msgToday} 条 · 记忆 ${c.memory} 条${c.replies?(' · 已回 '+c.replies):''}</span>
      ${c.type === 'group' ? `<button class="btn sm ${c.inWhitelist ? 'danger' : ''}" data-whitelist="${c.inWhitelist ? 'remove' : 'add'}" data-group="${c.id}">${c.inWhitelist ? '移出白名单' : '加入白名单'}</button>` : ''}
      ${c.type === 'group' ? summaryControls(c.id) : ''}
      <button class="btn danger sm" data-delchat="${c.key}" title="删除会话（记忆、设置、白名单）">删除</button>
      <span class="mut">▾</span>
    </div>
    <div class="body">
      <div class="frow"><label>聊天开关</label><div><label class="switch"><input type="checkbox" data-f="enabled" ${r.enabled === false ? '' : 'checked'}><i></i></label> <span class="mut">${c.type==='group'?'关掉后停止普通聊天；拍一拍、自动 +1 在“回复行为”单独控制':'关掉后停止普通私聊回复；拍一拍在“回复行为”单独控制'}</span></div></div>
      <div class="frow"><label>${c.type==='group'?'被 @ / 引用时回复':'回复私聊消息'}</label><div><label class="switch"><input type="checkbox" data-f="atReplyEnabled" ${r.atReplyEnabled === false ? '' : 'checked'}><i></i></label> <span class="mut">${c.type==='group'?'引用机器人自己的发言也视为直接对话，无需另加 @':'收到私聊消息时回复，不按群聊主动搭话概率抽取'}</span></div></div>
      ${c.type==='group'?`<div class="frow"><label>允许主动搭话</label><div><label class="switch"><input type="checkbox" data-f="proactiveEnabled" ${r.proactiveEnabled === false ? '' : 'checked'}><i></i></label> <span class="mut">仅在白名单群里有效${override('proactiveEnabled')}</span></div></div>
      <div class="frow"><label>主动搭话概率</label><div>
        <div class="row"><input type="range" min="0" max="1" step="0.01" data-f="proactiveRate" value="${rateVal}">
        <span class="pill" data-show="proactiveRate">${(rateVal*100).toFixed(0)}%</span>
        <label class="mut" style="font-size:12px"><input type="checkbox" data-global="proactiveRate" ${r.proactiveRate===null||r.proactiveRate===undefined?'checked':''}> ${rateOrigin}(${(defaultRate*100).toFixed(0)}%)</label><a href="#humanize" class="mut" style="font-size:12px">修改默认值</a></div>
      </div></div>`:''}
      <div class="frow"><label>装饰符号频率</label><div>
        <div class="row"><input type="range" min="0" max="1" step="0.01" data-f="emojiKeepRate" value="${emojiVal}">
        <span class="pill" data-show="emojiKeepRate">${(emojiVal*100).toFixed(0)}%</span>
        <label class="mut" style="font-size:12px"><input type="checkbox" data-global="emojiKeepRate" ${r.emojiKeepRate===null||r.emojiKeepRate===undefined?'checked':''}> 沿用全局(${((Number(state?.config?.emojiKeepRate)||0)*100).toFixed(0)}%)</label></div>
      </div></div>
      <div class="frow"><label>最多行数 / 单行字数</label><div class="row">
        <input type="number" min="1" max="5" data-f="replyMaxLines" value="${linesVal}" style="width:80px">
        <input type="number" min="10" max="200" data-f="lineMaxChars" value="${charsVal}" style="width:90px">
        <label class="mut" style="font-size:12px"><input type="checkbox" data-global="replyMaxLines" ${r.replyMaxLines==null&&r.lineMaxChars==null?'checked':''}> 沿用全局(${state?.config?.replyMaxLines ?? '—'}行 / ${state?.config?.lineMaxChars ?? '—'}字)</label>
      </div></div>
      <div class="frow"><label>安静时段</label><div class="row">
        <input type="text" data-f="quietHours" value="${esc(quietVal)}" placeholder="如 01:00-07:00，留空=不设" style="width:200px">
        <label class="mut" style="font-size:12px"><input type="checkbox" data-global="quietHours" ${r.quietHours===null||r.quietHours===undefined?'checked':''}> 沿用全局(${esc((state?.config?.quietHours)||'未设')})</label>
      </div></div>
      <div class="frow"><label>本会话人格</label><div><select data-f="persona">${personaOptions(r.persona)}</select><div class="mut" style="font-size:12px;margin-top:4px">选了别人格时，这个会话用该人格回复（切换时仅重置本会话记忆，清理前自动备份）</div></div></div>
      <div class="frow"><label>备注名</label><div><input type="text" data-f="note" value="${esc(r.note||'')}" placeholder="只影响这里的显示"></div></div>
      <div class="frow"><label>客制化 prompt</label><div>
        <textarea data-f="customPrompt" placeholder="这个会话专属的人设/要求，会附加到系统提示词后面。例如：这个群是我的同事群，说话正式一点，不要提游戏。">${esc(r.customPrompt||'')}</textarea>
        <div class="mut" style="font-size:12px;margin-top:4px">优先级高于全局人设，仅对本会话生效</div>
      </div></div>
      <div class="flexbar">
        <button class="btn primary" data-save="${c.key}">保存本会话设置</button>
        <button class="btn" data-reset="${c.key}">恢复默认</button>
        <button class="btn" data-mem="${c.key}">查看记忆</button>
        <button class="btn" data-say="${c.key}">发一条消息…</button>
        ${c.type === 'group' ? ('<button class="btn" data-watch="' + c.key + '">' + (isWatching(c.id) ? '取消盯人' : '设为盯人') + '</button>') : ''}
      </div>
    </div>
  </div>`
}
function isWatching(groupId){
  const t = state?.config?.targetWatch
  return Boolean(t && String(t.group) === String(groupId))
}
function personaOptions(cur){
  const head = '<option value="">跟随全局（' + esc(state?.config?.activePersona || '默认') + '）</option>'
  return head + personas.map(function(p){
    return '<option value="' + esc(p.name) + '"' + (cur === p.name ? ' selected' : '') + '>' + esc(p.name) + '</option>'
  }).join('')
}
function pageChats(){
  const groups = chats.filter(c=>c.type==='group'), priv = chats.filter(c=>c.type==='private')
  const whitelist = (state?.config?.whitelist || []).map(id => ({id, name: groupName(id)}))
  return `
  <h1>会话管理</h1><div class="sub">为每个群聊或私聊设置回复方式。保存后即时生效。</div>
  <section class="card group-manager" aria-label="白名单群聊管理">
    <div class="section-head"><div><h2>白名单群聊 <span class="badge whitelist">${whitelist.length} 个群</span></h2><div class="note">机器人可以在这些群主动搭话，概率在「回复行为」中设置。</div></div><button class="btn primary" id="importWhitelist">＋ 添加 / 导入白名单群</button></div>
    <div class="group-list">${whitelist.map(g => `<div class="group-item"><div class="group-identity"><strong>${esc(g.name)}</strong><small>群号 ${g.id}</small></div>${summaryControls(g.id)}<button class="btn sm" data-open-chat="g${g.id}">会话设置</button><button class="btn danger sm" data-whitelist="remove" data-group="${g.id}">移出白名单</button></div>`).join('') || '<div class="empty">还没有白名单群，点击右上方按钮添加。</div>'}</div>
    <div class="note" style="margin-top:12px">移出后停止主动搭话；聊天记录和会话设置保留，被 @ 回复与定时任务按各自设置执行。</div>
  </section>
  <div class="card">
    <div class="toolgroup">
      <input id="chatSearch" type="text" placeholder="搜索群名、群号或 QQ 号" aria-label="搜索会话" style="max-width:300px">
      <span class="badge">${chats.length} 个会话</span>
    </div>
    <div class="toolgroup">
      <select id="newchatType" aria-label="会话类型" style="max-width:120px"><option value="g">普通群聊</option><option value="w">白名单群</option><option value="p">私聊（加入白名单）</option></select>
      <select id="newchatPick" aria-label="选择联系人或群" style="max-width:260px"></select>
      <input id="newchat" type="text" inputmode="numeric" placeholder="或直接输入号码" style="max-width:160px">
      <button class="btn" id="addchat">添加普通会话</button><button class="btn" id="cleanGroups" title="把不在白名单里的群从会话列表里删掉（记忆和设置一起清）">清理非白名单群</button><span class="note">需要主动搭话的群，请使用上方「添加 / 导入白名单群」。</span>
    </div>
  </div>
  <h2>群聊（${groups.length}）</h2>
  ${groups.map(chatRow).join('') || '<div class="empty">还没有群会话</div>'}
  <h2>私聊（${priv.length}）</h2>
  ${priv.map(chatRow).join('') || '<div class="empty">还没有私聊会话</div>'}`
}

// ── 页面：人格 ──────────────────────────────────────────
function downloadPersonaFile(filename, content){
  const blob = new Blob(['\uFEFF', String(content)], {type:'text/plain;charset=utf-8'})
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename; document.body.appendChild(link)
  link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function readPersonaFile(file){
  if (!/\.(txt|md)$/i.test(file.name)) throw Error('请选择 .txt 或 .md 人格文件')
  if (file.size > 262144) throw Error('人格文件不能超过 256 KB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let content
  if (bytes[0] === 0xff && bytes[1] === 0xfe) content = new TextDecoder('utf-16le').decode(bytes)
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) content = new TextDecoder('utf-16be').decode(bytes)
  else {
    try { content = new TextDecoder('utf-8', {fatal:true}).decode(bytes) }
    catch { content = new TextDecoder('gb18030').decode(bytes) }
  }
  content = content.replace(/^\uFEFF/, '')
  if (!content.trim() || content.includes('\u0000')) throw Error('文件为空或不是可读取的纯文本人格')
  return content
}
function suggestPersonaName(filename){
  const stem = filename.replace(/\.(txt|md|json)$/i, '')
  const match = /^Koukou-(.+?)-人格(?:-\d{4}-\d{2}-\d{2})?$/.exec(stem)
  const base = (match?.[1] || stem).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 50) || '导入人格'
  let name = base, number = 2
  const names = new Set(personas.map(p => p.name.toLowerCase()))
  while (names.has(name.toLowerCase())) name = `${base}（${number++}）`
  return name
}
function previewPersonaImport(file, content, greetings=null){
  const root = document.getElementById('modalRoot')
  root.innerHTML = `<div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="personaImportTitle"><h2 id="personaImportTitle">导入人格</h2><p>预览后保存到人格库；人格包中的早晚安语库一并导入。编辑人格正文后会舍弃原语库，避免语气混用。</p><div class="note">文件：${esc(file.name)}</div><label class="field-label" for="personaImportName">人格名称</label><input id="personaImportName" type="text" maxlength="60"><label class="field-label" for="personaImportContent">内容预览（可以编辑）</label><textarea id="personaImportContent" style="min-height:210px"></textarea><label class="row"><input id="personaImportActivate" type="checkbox">导入后立即使用</label><div class="inline-error" id="personaImportError" role="status"></div><div class="row"><button class="btn" id="personaImportCancel">取消</button><button class="btn primary" id="personaImportCommit">保存到人格库</button></div></div>`
  root.classList.add('show'); root.setAttribute('aria-hidden', 'false')
  root.querySelector('#personaImportName').value = suggestPersonaName(file.name)
  root.querySelector('#personaImportContent').value = content
  let pending = false
  const close = () => {
    if (pending) return
    root.classList.remove('show'); root.setAttribute('aria-hidden', 'true'); root.innerHTML = ''; root.onclick = null
    document.removeEventListener('keydown', onKey); document.getElementById('importPersonaBtn')?.focus()
  }
  const onKey = ev => { if (ev.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  root.onclick = ev => { if (ev.target === root) close() }
  root.querySelector('#personaImportCancel').onclick = close
  root.querySelector('#personaImportCommit').onclick = async () => {
    const name = root.querySelector('#personaImportName').value.trim()
    const text = root.querySelector('#personaImportContent').value
    const activate = root.querySelector('#personaImportActivate').checked
    const button = root.querySelector('#personaImportCommit'), error = root.querySelector('#personaImportError')
    if (pending) return
    pending = true; button.disabled = true; error.textContent = ''
    try {
      const imported = await api('/api/action/import-persona', {name, content:text, greetings: text.trim()===content.trim()?greetings:null})
      personaCache[imported.name] = imported.content; selectedPersona = imported.name
      let activationError = ''
      if (activate) {
        try { await api('/api/action/activate-persona', {name:imported.name}) }
        catch(e){ activationError = '；切换未成功，可稍后选择“切换使用”：' + e.message }
      }
      pending = false; close(); await load()
      toast('已保存「' + imported.name + '」' + (activate && !activationError ? '并全局使用（旧会话记忆已备份并重置）' : '，可从人格库切换') + activationError, !!activationError)
    } catch(e){ error.textContent = e.message; pending = false; button.disabled = false }
  }
  root.querySelector('#personaImportName').focus()
}
function pagePersona(){
  const cur = personas.find(p=>p.name === selectedPersona) || personas.find(p=>p.active) || personas[0]
  return `
  <h1>人格编辑</h1><div class="sub">当前生效：<b>${esc(activePersona || '（默认 persona.txt）')}</b> · 全局切换，所有群聊与私聊同步生效</div>
  <h2>人格库 <span class="pill">${personas.length} 个</span></h2><div class="note">导入或新建的人格会保存在列表中。选择后可编辑、导出或切换使用。实际切换会先备份，再清空所有会话的近期与长期记忆，并取消旧人格待发回复；群总结原始记录与人格文件保留。重复启用未修改的人格不会清空。</div>
  <div class="flexbar">
    <select id="personaSel" aria-label="选择人格">${personas.map(p=>`<option value="${esc(p.name)}" ${cur?.name === p.name?'selected':''}>${esc(p.name)}${p.active?'（使用中）':''}</option>`).join('')}</select>
    <button class="btn primary" id="activate">切换使用</button>
    <button class="btn" id="importPersonaBtn">导入文件</button><input id="importPersonaFile" type="file" accept=".txt,.md,.json,text/plain,text/markdown,application/json" hidden>
    <button class="btn" id="exportActivePersona">导出当前使用</button>
    <input id="newPersona" type="text" placeholder="新人格名称" style="width:160px">
    <button class="btn" id="createPersona">新建</button>
    <button class="btn danger" id="delPersona">删除当前选中</button>
  </div>
  <div class="flexbar"><button class="btn" id="personaCheck">一致性检查</button><span id="personaCheckResult" class="mut"></span></div>
  <div class="card">
    <h3>人格 prompt（保存到人格库，点击“切换使用”后生效）</h3>
    <textarea id="personaText" style="min-height:340px;font-size:13.5px">${esc(cur ? (personaCache[cur.name] ?? '') : '')}</textarea>
    <div class="flexbar">
      <button class="btn primary" id="savePersona">保存</button>
      <button class="btn" id="exportEditedPersona">导出编辑内容</button>
      <button class="btn" id="editGreetingLibrary">编辑此人格的早晚安语库</button>
      <span class="mut" id="personaHint">选择左侧下拉可切换要编辑的人格</span>
    </div>
  </div>
  <div class="note">导出当前使用：下载人格与其早晚安语库的 JSON 人格包，可迁移至其他实例。导出编辑内容：只下载文字 TXT。导出不额外打包群号配置或聊天记录；切换人格只读取对应语库，缺失时跳过问候。</div>
  <h2>系统附加说明（只读）</h2>
  <div class="card"><div class="mono" style="max-height:260px;overflow:auto">${esc(appendixText)}</div></div>`
}

// ── 页面：配置表单（拟人化 / 接口 / 报告）─────────────────
function groupName(id){
  return chats.find(c => c.type === 'group' && Number(c.id) === Number(id))?.name || joinedGroups.find(g => Number(g.id) === Number(id))?.name || ('群 ' + id)
}
function availableGroups(){
  const groups = new Map(joinedGroups.map(g => [Number(g.id), {id:Number(g.id), name:g.name}]))
  for (const c of chats.filter(c => c.type === 'group')) groups.set(Number(c.id), {id:Number(c.id), name:c.name})
  for (const id of state?.config?.whitelist || []) if (!groups.has(Number(id))) groups.set(Number(id), {id:Number(id), name:groupName(id)})
  return [...groups.values()]
}
function rateRow(id, rate){
  const chat = chats.find(c => c.type === 'group' && Number(c.id) === Number(id))
  const override = chat?.raw?.proactiveRate
  return `<div class="group-item" data-rate-group="${id}"><div class="group-identity"><strong>${esc(groupName(id))}</strong><small>群号 ${id}${chat?.inWhitelist ? ' · 白名单' : ''}</small>${override != null ? `<small style="color:var(--warn)">会话已单独设置 ${Number((override*100).toFixed(4))}%，优先于此处</small>` : ''}</div><label class="rate-percent"><input type="number" min="0" max="100" step="any" value="${Number((rate*100).toFixed(8))}" data-rate-percent aria-label="${esc(groupName(id))}的主动搭话概率（百分比）"><span>%</span></label><button class="btn sm" type="button" data-remove-rate>沿用全局</button></div>`
}
function groupRateEditor(value){
  const rows = String(value || '').split(',').filter(Boolean).map(piece => {
    const [id, rate] = piece.split(':')
    return rateRow(Number(id), Number(rate))
  }).join('')
  return `<div class="rate-editor"><input type="hidden" data-cfg="PROACTIVE_RATE_PER_GROUP" value="${esc(value)}"><div class="group-list" id="groupRateRows">${rows}</div><div class="empty" id="rateEmpty" ${rows ? 'hidden' : ''}>没有单独设置的群，均沿用全局概率。</div><div class="inline-error" id="rateError" role="status"></div><div class="rate-add"><select id="rateGroupPick" aria-label="选择需要单独设置概率的群"><option value="">选择群聊…</option>${availableGroups().map(g => `<option value="${g.id}">${esc(g.name)}（${g.id}）</option>`).join('')}<option value="manual">手动输入群号</option></select><input id="rateGroupId" type="text" inputmode="numeric" aria-label="手动输入概率目标群号" placeholder="输入群号" hidden><button class="btn" id="addGroupRate" type="button">＋ 添加群概率</button></div></div>`
}
async function importWhitelist(){
  const root = document.getElementById('modalRoot')
  root.innerHTML = `<div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="importTitle"><h2 id="importTitle">添加白名单群聊</h2><p>选择群聊，或粘贴多个群号。导入后即时生效。</p><label class="field-label" for="whitelistPick">从已知群聊中选择</label><select id="whitelistPick"><option value="">选择一个群…</option>${availableGroups().filter(g => !(state?.config?.whitelist || []).map(Number).includes(g.id)).map(g => `<option value="${g.id}">${esc(g.name)}（${g.id}）</option>`).join('')}</select><div class="note">QQ 离线时可能无法获取新加入的群，可直接输入群号。</div><label class="field-label" for="whitelistInput">群号（支持批量导入）</label><textarea id="whitelistInput" placeholder="每行一个群号，也支持逗号或空格分隔"></textarea><div id="whitelistPreview" class="import-preview" aria-live="polite"></div><div class="row"><button class="btn" id="importCancel">取消</button><button class="btn primary" id="importCommit" disabled>请先选择或输入群号</button></div></div>`
  root.classList.add('show'); root.setAttribute('aria-hidden','false')
  const input = root.querySelector('#whitelistInput'), commit = root.querySelector('#importCommit')
  let newIds = [], pending = false
  const close = () => { if (pending) return; root.classList.remove('show'); root.setAttribute('aria-hidden','true'); root.innerHTML = ''; root.onclick = null; document.removeEventListener('keydown', onKey); document.getElementById('importWhitelist')?.focus() }
  const onKey = ev => { if (ev.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  root.onclick = ev => { if (ev.target === root) close() }
  root.querySelector('#importCancel').onclick = close
  const preview = () => {
    const tokens = input.value.trim().split(/[\s,，;；]+/).filter(Boolean)
    const invalid = tokens.filter(id => !/^\d{5,12}$/.test(id))
    const ids = [...new Set(tokens.filter(id => /^\d{5,12}$/.test(id)).map(id => String(Number(id))))]
    const existing = new Set((state?.config?.whitelist || []).map(String))
    newIds = ids.filter(id => !existing.has(id))
    root.querySelector('#whitelistPreview').innerHTML = invalid.length ? `<div class="inline-error">这些内容不是有效群号：${invalid.map(esc).join('、')}。请填写 5～12 位数字。</div>` : ids.length ? ids.map(id => `<div class="preview-line"><span>${esc(groupName(id))} <span class="mut">${id}</span></span><span class="badge ${existing.has(id) ? '' : 'live'}">${existing.has(id) ? '已在白名单 · 跳过' : '待添加'}</span></div>`).join('') + '<div class="note">重复群号自动合并，已有白名单群不重复添加。</div>' : '<div class="note">输入后会在这里预览待添加的群。</div>'
    commit.disabled = !!invalid.length || !newIds.length
    commit.textContent = newIds.length && !invalid.length ? `添加 ${newIds.length} 个白名单群` : ids.length && !invalid.length ? '这些群已在白名单中' : '请先选择或输入群号'
  }
  input.oninput = preview
  root.querySelector('#whitelistPick').onchange = ev => {
    if (!ev.target.value) return
    input.value = input.value.trim() + (input.value.trim() ? '\n' : '') + ev.target.value
    ev.target.value = ''; preview()
  }
  commit.onclick = async () => {
    preview(); if (commit.disabled) return
    pending = true; commit.disabled = true; commit.textContent = '正在添加…'
    try { const result = await api('/api/action/update-whitelist', {operation:'add', groupIds:newIds}); pending = false; close(); await load(); toast(`已添加 ${result.changed} 个白名单群，即时生效`) }
    catch(e){ pending = false; preview(); toast('添加失败：' + e.message, true) }
  }
  preview(); root.querySelector('#whitelistPick').focus()
}
function configForm(keys, hint){
  const items = configItems.filter(i=>keys.includes(i.key))
  return items.map(i => {
    const v = i.effective !== '' ? i.effective : i.value
    const inactive = state?.config?.summaryUnrestricted && ['SUMMARY_MAX_MESSAGES','SUMMARY_MAX_TOKENS','SUMMARY_TASK_TIMEOUT_MINUTES'].includes(i.key)
    const badge = inactive ? '<span class="badge">宽裕模式下不生效</span>' : i.live ? '<span class="badge live">即时生效</span>' : '<span class="badge restart">需重启</span>'
    let input
    if (i.key === 'PROACTIVE_RATE_PER_GROUP') input = groupRateEditor(v)
    else if (i.type === 'bool') input = `<label class="switch"><input type="checkbox" data-cfg="${i.key}" ${(v==='1'||v==='true')?'checked':''}><i></i></label>`
    else if (i.type === 'rate') input = `<input type="range" min="0" max="1" step="0.01" data-cfg="${i.key}" value="${v||0}"> <span class="pill" data-cfgshow="${i.key}">${((Number(v)||0)*100).toFixed(0)}%</span>`
    else if (i.type === 'secret') input = `<div class="row"><input type="password" data-cfg="${i.key}" data-secret="1" value="" placeholder="${i.configured ? '已设置，留空不修改' : '尚未设置'}" autocomplete="new-password" style="flex:1;min-width:180px"><button class="btn sm" type="button" data-reveal="${i.key}">显示输入</button></div>`
    else if (i.key === 'VISION_PROVIDER' || i.key === 'SUMMARY_PROVIDER') input = `<select data-cfg="${i.key}"><option value="deepseek" ${v==='deepseek'?'selected':''}>DeepSeek</option><option value="dashscope" ${v==='dashscope'?'selected':''}>DashScope（通义千问）</option></select>`
    else if (i.key === 'DEEPSEEK_REASONING_EFFORT') input = `<select data-cfg="${i.key}">${[['','沿用服务端默认'],['none','关闭思考'],['low','Low · 较少思考'],['high','High · 充分思考'],['max','Max · 最大思考投入']].map(([value,label])=>`<option value="${value}" ${v===value?'selected':''}>${label}</option>`).join('')}</select>`
    else if (i.key === 'SUMMARY_SEND_MODE') input = `<select data-cfg="${i.key}"><option value="forward" ${v==='forward'?'selected':''}>合并转发卡片</option><option value="split" ${v==='split'?'selected':''}>按空行逐段发送</option></select>`
    else if (i.key === 'LOG_LEVEL') input = `<select data-cfg="${i.key}"><option value="debug" ${v==='debug'?'selected':''}>详细调试</option><option value="info" ${v==='info'?'selected':''}>正常信息</option><option value="warn" ${v==='warn'?'selected':''}>只看警告与错误</option><option value="error" ${v==='error'?'selected':''}>只看错误</option></select>`
    else input = `<input type="${i.type==='number'?'number':'text'}" data-cfg="${i.key}" value="${esc(v)}">`
    if (inactive) input = `<fieldset disabled style="border:0;padding:0;margin:0;opacity:.5">${input}</fieldset>`
    const fieldHint = ['SUMMARY_SEND_MODE','LOG_LEVEL'].includes(i.key) ? '' : (i.hint||'')
    return `<div class="frow"><label>${i.label} ${badge}</label><div>${input}${fieldHint ? `<div class="mut" style="font-size:12px;margin-top:3px">${fieldHint}</div>` : ''}</div></div>`
  }).join('') + `<div class="flexbar sticky-save"><button class="btn primary" id="saveCfg" disabled>没有待保存的改动</button><span class="mut" id="cfgDirty">${hint||''}</span></div>`
}
function pageHumanize(){
  const greetings=state?.config?.quietGreetings
  return `<h1>回复行为</h1><div class="sub">这里修改“沿用全局”的默认值；会话单独设置优先，其次是按群独立概率，最后才是全局概率。</div>
  <div class="flexbar"><a class="btn" href="#chats">管理白名单群聊 →</a><span class="note">概率填写百分比，例如 20%，不需要输入配置格式。</span></div>
  <div class="card">${configForm(['PROACTIVE_RATE','PROACTIVE_RATE_PER_GROUP','PROACTIVE_COOLDOWN_MS','EMOJI_KEEP_RATE','HUMAN_DELAY_MIN_MS','HUMAN_DELAY_MAX_MS','REPLY_LENGTH_MATCH','REPLY_MIN_BUDGET','REPLY_MAX_LINES','REPLY_LINE_MAX_CHARS','LINE_GAP_MIN_MS','LINE_GAP_MAX_MS','RATE_LIMIT_PER_HOUR','RATE_LIMIT_MIN_GAP_MS','QUIET_HOURS','QUIET_GREETINGS_ENABLED','HISTORY_LIMIT','CONTEXT_REMEMBER_ALL','POKE_REPLY_ENABLED','AUTO_PLUS_ONE_ENABLED','PRIVATE_WHITELIST'],'修改全局概率不会覆盖已经单独设置的群；限流相关参数需重启生效。')}</div><div class="note">固定语库早晚安：${greetings?.enabled?'已启用':'未启用'}；语库就绪 ${greetings?.groups?.filter(g=>g.ready).length||0}/${greetings?.groups?.length||0} 群。检查时段、选句和发送均不调用 AI。<a href="#persona">前往人格页面编辑或导出语库 →</a> <button class="btn sm" id="catchUpMorning">补发本轮未发的早安</button></div>`
}
function webSearchCard(){
  const info = webSearchInfo || {}
  const presets = ['deepseek','qwen-plus','qwen-max','qwen-turbo','qwen3-max','qwen-flash','bing']
  const providerName = { dashscope: '通义千问', deepseek: 'DeepSeek 搜索', bing: '必应网页', baidu: '百度千帆' }
  const cur = info.provider === 'deepseek' ? 'deepseek' : (info.provider === 'bing' ? 'bing' : (info.model || 'qwen-plus'))
  if (presets.indexOf(cur) < 0) presets.unshift(cur)
  const label = { deepseek: 'DeepSeek 搜索（自带引擎）', bing: '必应网页（免密钥兜底）' }
  const opts = presets.map(function(m){ return '<option value="' + esc(m) + '"' + (m === cur ? ' selected' : '') + '>' + esc(label[m] || m) + '</option>' }).join('')
  return '<details class="card" data-apicard="search"' + (apiCardsOpen.search ? ' open' : '') + '><summary><b class="api-card-title">联网搜索</b> <span class="api-card-meta">'
    + (info.enabled ? '已开启' : '已关闭') + ' · ' + esc(providerName[info.provider] || '—') + '</span></summary>'
    + '<div class="note" style="margin-top:8px">由模型判断要不要搜。模型下拉里选 DeepSeek / 通义模型 / 必应，保存即时生效。</div>'
    + '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:10px 0"><input type="checkbox" id="wsEnabled"' + (info.enabled ? ' checked' : '') + '> 允许联网搜索</label>'
    + '<div class="frow"><label>搜索模型</label><div><select id="wsModel">' + opts + '</select>'
    + '<div class="mut" style="font-size:12px;margin-top:3px">当前实际：' + esc(providerName[info.provider] || info.provider || '—') + '</div></div></div>'
    + '<div class="flexbar"><button class="btn primary" id="wsSave">保存（即时生效）</button><span class="mut" id="wsHint"></span></div></details>'
}
function pageApi(){
  return modelPickerCard() + visionCard() + webSearchCard() + `<h1>模型与接口</h1><div class="sub">对话模型、思考强度改完立刻生效；下方视觉模型与其它项按标注生效。</div>
  <div class="card"><strong>当前生效的识图模型：</strong>${esc(state?.bot?.visionModel || '未启用')}<div class="mut" style="margin-top:5px">图片识别与群聊报告分别配置；下方的 DashScope 模型只有切换识图服务商后才会用于读图。</div></div>
  <div class="card">${configForm(['TEMPERATURE','MAX_TOKENS','DASHSCOPE_API_KEY','BAIDU_QIANFAN_API_KEY','LOG_LEVEL'],'已设置的密钥不会显示；留空保持原值。')}</div>`
}
function pageReport(){
  return `<h1>群聊报告</h1><div class="sub">每日自动生成「群聊日常分析报告」，也可以在这里随时手动生成</div>
  <div class="card">${configForm(['SUMMARY_ENABLED','SUMMARY_FALLBACK_ENABLED','SUMMARY_TIMES','SUMMARY_GROUPS','SUMMARY_SEND_MODE','SUMMARY_UNRESTRICTED','SUMMARY_REQUEST_TIMEOUT_SECONDS','SUMMARY_BOT_USERS','SUMMARY_MAX_MESSAGES','SUMMARY_MAX_TOKENS','SUMMARY_CONCURRENCY','SUMMARY_TASK_TIMEOUT_MINUTES','SUMMARY_PROVIDER','SUMMARY_MODEL','SUMMARY_VISION_MODEL','SUMMARY_REFERENCE_MAX_IMAGES'],'')}</div>
  <div class="note">${state?.config?.summaryUnrestricted ? `当前宽裕模式：整份总结不限总时长；单次模型等待 ${state.config.summaryRequestTimeoutSeconds ?? 900} 秒后可有限重试。` : '当前使用普通模式的准备时限与篇幅设置。'} 服务商容量限制仍存在；发送结果不明确时不会盲目重发。</div>
  <h2>立即生成</h2>
  <div class="card"><div class="row">
    <select id="sumGroup">${chats.filter(c=>c.type==='group').map(c=>`<option value="${c.id}">${esc(c.name)}（${c.id}）</option>`).join('')}</select>
    <input id="sumDays" type="number" value="1" min="1" max="30" style="width:80px">
    <span class="mut">天</span>
    <button class="btn primary" id="doSummary">生成并发送</button>
  </div><div class="mut" style="font-size:12px;margin-top:6px">生成耗时随消息量和模型响应变化；完成后会直接发到群里</div></div>
  <h2>历史报告</h2>
  <div class="card" id="dailyList"></div>`
}
function pageLogs(){
  return `<h1>运行日志</h1><div class="sub">查看机器人最近的运行信息与错误，可按关键词过滤。</div>
  <div class="flexbar">
    <input id="logFilter" type="text" placeholder="过滤关键词，如 已回复 / 限流 / 形态" value="${esc(logFilter)}" style="width:260px">
    <label class="switch"><input type="checkbox" id="logAuto" ${logAuto?'checked':''}><i></i></label><span class="mut">自动刷新</span>
    <select id="logLines"><option>100</option><option selected>200</option><option>500</option><option>1000</option></select>
  </div>
  <div class="logbox mono" id="logBot" style="max-height:420px"></div>`
}
function pokeCorpusCard(){
  return '<details class="card"><summary><b>拍一拍语库</b> <span class="pill">' + pokeReplies.length + ' 条</span> <span class="mut">点开编辑语料</span></summary>' +
    '<div class="note">一行一条；<code>#</code> 开头的行不生效；<code>{name}</code> 会替换成拍你的人。保存后立即生效，随机抽取且不会连续重复。</div>' +
    '<textarea id="pokeText" rows="10" style="width:100%;margin-top:8px">' + esc(pokeReplies.join('\n')) + '</textarea>' +
    '<div class="flexbar"><button class="btn primary" id="pokeSave">保存语库</button><span class="mut" id="pokeHint"></span></div></details>'
}
async function loadPythonScripts(){
  const r = await api('/api/python-scripts').catch(function(){ return { items: [] } })
  pythonScripts = r.items || []
  pythonDir = r.dir || pythonDir
  if (r.settings) pythonSettings = r.settings
}
function pythonCard(){
  const items = pythonScripts || []
  const recall = (pythonSettings && pythonSettings.recallSeconds) || 300
  const rows = items.map(function(s){
    const id = esc(s.id)
    return '<details class="frow"' + (pyOpen.rows.indexOf(s.id) >= 0 ? ' open' : '') + '><summary><b>' + esc(s.name) + '</b> <span class="mut">/' + id + '</span>' +
      (s.enabled === false ? ' <span class="pill">已停用</span>' : '') + '</summary>' +
      '<div class="mut" style="margin:6px 0 4px">' + esc(s.description || '') + '</div>' +
      '<div class="mut" style="font-size:12px">用法：' + esc(s.usage || ('/py ' + s.id)) + '</div>' +
      '<div class="flexbar" style="margin-top:8px"><label class="mut">调用名 /py</label>' +
        '<input data-pycmd="' + id + '" value="' + esc(s.command || s.id) + '" style="width:120px" maxlength="20">' +
        '<button class="btn sm" data-pycmdsave="' + id + '">保存调用名</button>' +
        '<span class="mut" style="font-size:12px">文件名 ' + id + '.py</span></div>' +
      '<div class="flexbar" style="margin-top:6px;gap:6px;flex-wrap:wrap"><span class="mut" style="font-size:12px;word-break:break-all">' + esc(s.path || '') + '</span><button class="btn sm" data-pycopy="' + esc(s.path || '') + '">复制</button><button class="btn sm" data-pyopen="' + id + '">定位文件</button></div>' +
      '<div class="flexbar" style="margin-top:8px">' +
        '<button class="btn sm" data-pyedit="' + id + '">编辑内容</button>' +
        '<button class="btn sm" data-pytoggle="' + id + '" data-next="' + (s.enabled === false ? '1' : '0') + '">' + (s.enabled === false ? '启用' : '停用') + '</button>' +
        '<button class="btn sm" data-pydel="' + id + '">删除</button>' +
      '</div>' +
      '<div id="pyEditor-' + id + '" style="display:' + (pyOpen.editors.indexOf(s.id) >= 0 ? '' : 'none') + ';margin-top:8px">' +
        '<textarea data-pysrc="' + id + '" spellcheck="false" style="width:100%;min-height:240px;font-family:Consolas,monospace;font-size:12px"></textarea>' +
        '<div class="flexbar" style="margin-top:6px"><button class="btn primary sm" data-pysave="' + id + '">保存</button><button class="btn sm" data-pycancel="' + id + '">取消</button><span class="mut" id="pyMsg-' + id + '"></span></div>' +
      '</div></details>'
  }).join('')
  return '<details class="card"' + (pyOpen.card ? ' open' : '') + ' data-pycard><summary><b>Python 脚本</b> <span class="pill">' + items.length + ' 个</span> <span class="mut">点开管理、编辑内容</span></summary>' +
    '<div class="note">放在 plugins/python 下的白名单脚本，用 <code>/py 脚本名 参数</code> 运行，默认仅管理员。脚本以机器人权限执行，只导入可信文件。保存会留一份 .bak。</div>' +
    '<div class="flexbar" style="margin:8px 0;gap:8px;flex-wrap:wrap"><span class="mut">脚本目录</span><code style="font-size:12px;word-break:break-all">' + esc(pythonDir || 'plugins/python') + '</code><button class="btn sm" data-pycopy="' + esc(pythonDir || '') + '">复制路径</button><button class="btn sm" data-pyopen="">打开文件夹</button></div>' +
    '<div class="flexbar" style="margin:10px 0"><label class="mut">打包默认撤回（秒）</label><input id="pyRecall" type="number" min="5" max="7200" step="5" value="' + recall + '" style="width:90px"><button class="btn sm" id="pyRecallSave">保存</button><span class="mut" id="pyRecallHint"></span></div>' +
    (rows || '<div class="mut">还没有脚本</div>') +
    '<details class="frow" style="margin-top:10px"><summary><b>＋ 新建脚本</b> <span class="mut">自己写，或让 AI 起草</span></summary>' +
      '<div class="mut" style="margin:8px 0 6px">描述你要的功能，AI 只生成草稿，代码会放在下面，确认后再保存。保存后即可用 <code>/py 文件名</code> 调用。</div>' +
      '<textarea id="pyPrompt" placeholder="例如：把一段文字倒序输出，并统计字符数；参数为空时提示用法" style="width:100%;min-height:70px"></textarea>' +
      '<div class="flexbar" style="margin:8px 0"><input id="pyNewName" placeholder="文件名，如 wc.py" style="width:170px"><input id="pyNewCmd" placeholder="调用名（可选）" style="width:140px" maxlength="20"><button class="btn sm" id="pyDraftBtn">AI 生成草稿</button><button class="btn sm" id="pyTplBtn">插入模板</button><span class="mut" id="pyDraftHint"></span></div>' +
      '<textarea id="pyNewCode" spellcheck="false" placeholder="代码会出现在这里，也可以自己直接写" style="width:100%;min-height:240px;font-family:Consolas,monospace;font-size:12px"></textarea>' +
      '<div class="flexbar" style="margin-top:6px"><button class="btn primary sm" id="pyNewSave">保存脚本</button><button class="btn sm" id="pyNewClear">清空</button><span class="mut" id="pyNewHint"></span></div>' +
    '</details>' +
    '<div class="flexbar" style="margin-top:10px"><label class="btn" style="cursor:pointer">导入 .py<input type="file" id="pyImport" accept=".py" style="display:none"></label><span class="mut" id="pyHint"></span></div></details>'
}
function syncPyOpen(){
  const card = document.querySelector('details[data-pycard]')
  if (card) pyOpen.card = card.open
  const rows = []
  document.querySelectorAll('details[data-pyrow]').forEach(function(d){ if (d.open) rows.push(d.dataset.pyrow) })
  pyOpen.rows = rows
  const eds = []
  document.querySelectorAll('[id^="pyEditor-"]').forEach(function(el){ if (el.style.display !== 'none') eds.push(el.id.replace('pyEditor-', '')) })
  pyOpen.editors = eds
}
function pageCommands(){ return CommandCenterUI.render({custom:customCommands,builtins:commandBuiltins,poke:pokeDiagnostics,groups:joinedGroups}) + commandTestCard() + pokeCorpusCard() + pythonCard() }
// ── 渲染 ───────────────────────────────────────────────
function pageMemory(){
  const nameOf = function(key){
    const c = (chats || []).find(function(x){ return String(x.key) === String(key) })
    if (c && c.name) return c.name
    if (String(key).startsWith('p')) return 'QQ ' + String(key).slice(1)
    if (String(key).startsWith('g')) return '群 ' + String(key).slice(1)
    return ''
  }
  const rowOf = function(m){
    const name = nameOf(m.key)
    return '<tr><td><b>' + esc(name) + '</b><div class="mut" style="font-size:12px">' + esc(m.key) + '</div></td><td>' + (m.recent||0) + ' 条</td><td>' + (m.longTermChars||0) + ' 字</td><td>' + (m.pending||0) + '</td>' +
      '<td><button class="btn" data-memview="' + esc(m.key) + '">' + (memoryDetail && memoryDetail.key === m.key ? '收回' : '查看') + '</button> <button class="btn" data-memclear="' + esc(m.key) + '">清空</button></td></tr>'
  }
  const groupList = memoryOverview.filter(function(m){ return String(m.key).startsWith('g') })
  const privList = memoryOverview.filter(function(m){ return String(m.key).startsWith('p') })
  const folder = function(type, title, list){
    const open = memoryFold[type] !== false
    const head = '<div class="mem-folder" data-memfold="' + type + '" style="cursor:pointer;padding:10px 0;border-bottom:1px solid var(--line,#eee);display:flex;align-items:center;gap:8px">'
      + '<b>' + (open ? '▾' : '▸') + ' ' + title + '</b><span class="pill">' + list.length + ' 个</span></div>'
    if (!open) return head
    if (!list.length) return head + '<div class="mut" style="padding:10px 0">还没有' + title + '记忆</div>'
    return head + '<table class="tbl"><thead><tr><th>会话</th><th>近期</th><th>长期</th><th>待整理</th><th>操作</th></tr></thead><tbody>' + list.map(rowOf).join('') + '</tbody></table>'
  }
  const d = memoryDetail
  const fmtTime = function(ts){ if(!ts) return ''; try { return new Date(ts).toLocaleString('zh-CN',{hour12:false}) } catch(e){ return '' } }
  const key = d ? d.key : ''
  const dayKeyOf = function(m){ return m.time ? new Date(m.time).toLocaleDateString('zh-CN') : '时间未知' }
  const memRow = function(m, idx){
    return '<div data-mem-row style="margin-bottom:10px;padding:8px 0 8px 12px;border-left:2px solid rgba(148,163,184,.25)">' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">' +
      '<span class="badge">' + (m.role === 'assistant' ? '机器人' : '对方') + '</span>' +
      '<span class="mut" style="font-size:12px">' + esc(fmtTime(m.time)) + '</span>' +
      '<button class="btn sm" data-mem-edit="' + idx + '">改</button>' +
      '<button class="btn sm" data-mem-del="' + idx + '">删</button>' +
      '</div><div>' + esc(m.content) + '</div></div>'
  }
  const groupByDay = function(list){
    const out = []
    for (let i = 0; i < list.length; i += 1) {
      const day = dayKeyOf(list[i])
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push({ item: list[i], idx: i })
      else out.push({ day, items: [{ item: list[i], idx: i }] })
    }
    return out
  }
  const todayKey = new Date().toLocaleDateString('zh-CN')
  const recentGroups = d ? groupByDay(d.recent || []) : []
  const recentRows = recentGroups.map(function(g){
    return '<details class="mem-day"' + (g.day === todayKey ? ' open' : '') + '><summary><b>' + esc(g.day) + '</b> <span class="pill">' + g.items.length + ' 条</span></summary>' +
      '<div class="mem-day-body">' + g.items.map(function(x){ return memRow(x.item, x.idx) }).join('') + '</div></details>'
  }).join('')
  const pendingGroups = d ? groupByDay(d.pending || []) : []
  const pendingRows = pendingGroups.map(function(g){
    return '<details class="mem-day"' + (g.day === todayKey ? ' open' : '') + '><summary><b>' + esc(g.day) + '</b> <span class="pill">' + g.items.length + ' 条</span></summary>' +
      '<div class="mem-day-body">' + g.items.map(function(x){
        const p = x.item
        return '<div data-mem-row style="margin-bottom:10px;padding:8px 0 8px 12px;border-left:2px solid rgba(148,163,184,.25)"><div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">' +
          '<span class="badge">' + esc(p.name || p.userId || '群友') + '</span>' +
          '<span class="mut" style="font-size:12px">' + esc(fmtTime(p.time)) + '</span>' +
          '<button class="btn sm" data-pending-del="' + x.idx + '">删</button></div><div>' + esc(p.text) + '</div></div>'
      }).join('') + '</div></details>'
  }).join('')
  const extraCards = [
    '<section class="card"><h2>长期记忆检索</h2><div class="note">按话题找回旧原话；也可以直接看某个会话的长期摘要。</div>' +
      '<div class="row"><select id="lmKey">' + chats.map(function(c){ return '<option value="' + esc(c.key) + '">' + esc(c.name) + '（' + esc(c.key) + '）</option>' }).join('') + '</select>' +
      '<input id="lmQuery" placeholder="可选：输入话题，找回相关旧原话" aria-label="长期记忆检索话题">' +
      '<button class="btn" id="loadLm">查看 / 检索</button></div>' +
      '<div class="mono" id="lmBox" style="max-height:240px;overflow:auto;margin-top:10px">—</div></section>',
    '<section class="card"><h2>日报原始文件</h2><div class="note">每天按群保存的原始消息，用于追溯。</div><div id="dailyFiles"></div></section>',
    backupCard(),
    '<section class="card"><h2>导出 / 导入</h2><div class="note">导出会下载一个 JSON 文件（保存位置由浏览器弹窗选择）；导入前会自动备份当前记忆。</div><div class="flexbar"><button class="btn" id="exportMemory">导出 JSON</button><button class="btn" id="exportMemoryMd">导出 Markdown</button><label class="btn" style="cursor:pointer">导入记忆<input type="file" id="memoryImport" accept="application/json,.json" style="display:none"></label></div></section>'
  ].join('')
  return [
    '<h1>记忆浏览</h1><div class="sub">当前人格 <b>' + esc(state?.config?.activePersona || '默认') + '</b>。近期、长期、待整理分开显示，都可以单条修改或删除。</div>',
    '<section class="card"><h2>会话列表 <span class="pill">' + memoryOverview.length + ' 个</span></h2>',
    memoryOverview.length ? (folder('group', '群聊', groupList) + folder('private', '私聊', privList)) : '<div class="mut">当前人格还没有任何记忆。</div>',
    '</section>',
    d ? [
      '<section class="card"><h2>近期记忆 <span class="pill">' + (d.recent||[]).length + ' 条</span> <span class="mut" style="font-size:12px">' + esc(nameOf(key)) + '（' + esc(key) + '）</span></h2>',
      '<div class="note">每条都能改正文或单条删除；删除只影响这一条。</div>',
      '<input id="memSearch" placeholder="搜索这段记忆的内容" style="width:100%;margin-top:8px">' +
      '<div id="memList" style="margin-top:8px">' + (recentRows || '<div class="mut">这个会话没有近期记忆。</div>') + '</div>',
      '</section>',
      '<section class="card"><h2>长期记忆 <span class="pill">' + (d.longTerm||'').length + ' 字</span>' + (d.updatedAt ? ' <span class="mut" style="font-size:12px">更新于 ' + esc(fmtTime(d.updatedAt)) + '</span>' : '') + '</h2>',
      '<div class="note">' + (d.paused ? '自动整理已暂停，可编辑。保存后保持暂停，新原文继续存档；恢复后才基于新摘要整理。' : (d.running ? '后台正在整理。请先暂停再编辑，旧任务会取消，迟到结果不会回写。' : '请先暂停自动整理再编辑。')) + '</div>',
      '<button class="btn" id="lmPause">' + (d.paused ? '恢复自动整理' : '暂停整理并编辑') + '</button>',
      '<textarea id="lmEdit"' + (d.paused ? '' : ' disabled') + ' style="width:100%;min-height:160px;margin-top:8px" placeholder="还没有整理出长期记忆，可以直接写">' + esc(d.longTerm || '') + '</textarea>',
      '<div class="flexbar"><button class="btn primary" id="lmSave"' + (d.paused ? '' : ' disabled') + '>保存长期记忆</button><span class="mut" id="lmHint" style="font-size:12px"></span></div>',
      '</section>',
      '<section class="card"><h2>待整理 <span class="pill">' + (d.pending||[]).length + ' 条</span></h2>',
      '<div class="note">从近期窗口挤出来的原文，攒够会自动压缩进长期记忆；不想留的可以单条删掉。</div>',
      '<div style="margin-top:8px">' + (pendingRows || '<div class="mut">没有待整理的原文。</div>') + '</div>',
      '</section>'
    ].join('') : '<section class="card"><div class="mut">点上面「查看」，会同时显示近期、长期和待整理三块内容。</div></section>'
  ].join('') + extraCards
}
function configFlag(key){
  const s = state?.config
  if (s) {
    if (key === 'REPLY_TIMING_ENABLED' && typeof s.replyTimingEnabled === 'boolean') return s.replyTimingEnabled
  }
  const it = (configItems || []).find(function(x){ return x.key === key })
  return Boolean(it && (String(it.effective || it.value).trim() === '1' || String(it.value).trim() === 'true'))
}
function modelPickerCard(){
  const m = modelsInfo || {}
  const cur = m.current || {}
  const providers = m.providers || []
  const levels = m.levels || []
  const modelList = modelsAvailable || []
  const opts = providers.map(function(p){
    return '<option value="' + esc(p.id) + '"' + (p.id === cur.provider ? ' selected' : '') + '>' + esc(p.name) + '</option>'
  }).join('')
  const lvls = levels.map(function(l){
    return '<option value="' + esc(l.id) + '"' + (String(cur.reasoning || '') === String(l.id) ? ' selected' : '') + '>' + esc(l.name) + '</option>'
  }).join('')
  const known = modelList.slice()
  if (cur.model && known.indexOf(cur.model) < 0) known.unshift(cur.model)
  const modelOpts = known.length
    ? known.map(function(id){ return '<option value="' + esc(id) + '"' + (id === cur.model ? ' selected' : '') + '>' + esc(id) + '</option>' }).join('')
    : '<option value="' + esc(cur.model || '') + '">' + esc(cur.model || '（先点自动检测）') + '</option>'
  return [
    '<details class="card" data-apicard="model"' + (apiCardsOpen.model ? ' open' : '') + '><summary><b class="api-card-title">对话模型</b> <span class="api-card-meta">' + esc(cur.provider || '') + ' · ' + esc(cur.model || '') + '</span></summary><div class="api-card-body">',
    '<div class="note">选供应商 → 点「自动检测模型」→ 从下拉里选型号。选完立刻生效，不用再点保存。</div>',
    '<div class="frow"><label>供应商</label><div><select id="mpProvider">' + opts + '</select></div></div>',
    '<div class="frow"><label>接口地址</label><div><input id="mpBaseUrl" value="' + esc(cur.baseUrl || '') + '" placeholder="https://api.deepseek.com"><div class="mut" style="font-size:12px;margin-top:4px">需要兼容 OpenAI 的 /chat/completions 与 /models</div></div></div>',
    '<div class="frow"><label>密钥</label><div><input id="mpKey" type="password" placeholder="' + (cur.hasKey ? '已配置，留空表示不修改' : '填 API Key') + '"><div class="mut" style="font-size:12px;margin-top:4px">检测模型和保存都会用到；不会显示明文</div></div></div>',
    '<div class="frow"><label>型号</label><div><select id="mpModel">' + modelOpts + '</select><div class="mut" id="mpHint" style="font-size:12px;margin-top:4px">' + (modelList.length ? ('已检测到 ' + modelList.length + ' 个型号') : '还没检测，点下面的按钮获取列表') + '</div></div></div>',
    '<div class="frow"><label>思考强度</label><div><select id="mpReason">' + lvls + '</select><div class="mut" style="font-size:12px;margin-top:4px">不是所有服务商都支持；报错就改回「关闭」</div></div></div>',
    '<div class="flexbar"><button class="btn" id="mpDetect">自动检测模型</button><button class="btn" id="mpSaveBase">保存地址/密钥</button></div>',
    '<div class="mut" id="mpStatus" style="margin-top:8px">当前：' + esc(cur.provider || '-') + ' · ' + esc(cur.model || '-') + ' · 思考 ' + esc(cur.reasoning || '关闭') + '</div>',
    '</div></details>'
  ].join('')
}
function visionCard(){
  const s = state?.config || {}
  const provider = s.visionProvider || 'deepseek'
  const tagProvider = s.stickerTagProvider || 'auto'
  const customs = s.visionProviders || []
  const isCustom = String(provider).startsWith('custom:')
  const currentId = isCustom ? String(provider).slice(7) : ''
  const modelByProvider = { deepseek: s.visionModelDeepseek || '', dashscope: s.visionModelDashscope || '' }
  const currentModel = isCustom ? ((customs.find(function(x){ return x.id === currentId }) || {}).model || '') : (modelByProvider[provider] || '')
  const sel = function(v, cur){ return v === cur ? ' selected' : '' }
  const row = function(label, body){ return '<div class="frow"><label>' + label + '</label><div>' + body + '</div></div>' }
  const providerOptions = [
    '<option value="deepseek"' + sel('deepseek', provider) + '>DeepSeek</option>',
    '<option value="dashscope"' + sel('dashscope', provider) + '>通义千问</option>',
  ].concat(customs.map(function(x){
    return '<option value="custom:' + esc(x.id) + '"' + sel('custom:' + x.id, provider) + '>' + esc(x.name) + (x.model ? '（' + esc(x.model) + '）' : '') + '</option>'
  })).join('')
  const customRows = customs.length ? customs.map(function(x){
    return '<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><span class="pill">' + esc(x.name) + '</span><span class="mut" style="font-size:12px">' + esc(x.baseUrl) + '</span><span class="mut" style="font-size:12px">' + esc(x.model || '未选模型') + '</span><button class="btn sm" data-vp-del="' + esc(x.id) + '">删除</button></div>'
  }).join('') : '<div class="mut">还没有自定义接口</div>'
  return [
    '<details class="card" data-apicard="vision"' + (apiCardsOpen.vision ? ' open' : '') + '><summary><b class="api-card-title">识图设置</b> <span class="api-card-meta">' + esc(provider) + ' · ' + esc(currentModel || '未选模型') + '</span></summary><div class="api-card-body">',
    '<div class="note">聊天读图与表情包打标都用这里的模型。可以添加多个自定义接口（OpenAI 兼容），在服务商里直接切换。</div>',
    row('服务商', '<select id="vcProvider">' + providerOptions + '</select>'),
    row('识图模型', '<div class="row" style="display:flex;gap:8px"><select id="vcModel" style="flex:1">' +
      '<option value="' + esc(currentModel) + '"' + (currentModel ? ' selected' : '') + '>' + esc(currentModel || '（先点自动检测）') + '</option>' +
      '</select><button class="btn" type="button" id="vcDetect">自动检测模型</button></div><div class="mut" id="vcDetectHint" style="font-size:12px;margin-top:4px">' + (isCustom ? '自定义：点检测拿型号列表' : '点「自动检测模型」拿型号列表') + '</div>'),
    row('识图思考强度', '<select id="vcReasoning">' + [['none','关闭（默认）'],['low','低'],['high','高'],['max','最高']].map(function(x){ return '<option value="' + x[0] + '"' + (x[0] === (s.visionReasoning || 'none') ? ' selected' : '') + '>' + x[1] + '</option>' }).join('') + '</select><div class="mut">DeepSeek Flash 固定使用 max，识图预算至少2048（仍受总预算限制）；其他模型使用独立设置。</div>'),
    row('识图 token 预算', '<input id="vcTokens" type="number" min="64" max="4000" value="' + (s.visionMaxTokens || 300) + '" style="width:120px"><div class="mut" style="font-size:12px;margin-top:3px">越大越能读复杂图，也越慢；默认 300</div>'),
    row('表情包打标模型', '<select id="vcTag">' +
      '<option value="auto"' + sel('auto', tagProvider) + '>自动（有通义用通义，否则 DeepSeek）</option>' +
      '<option value="deepseek"' + sel('deepseek', tagProvider) + '>DeepSeek</option>' +
      '<option value="dashscope"' + sel('dashscope', tagProvider) + '>通义千问</option>' +
      '<option value="custom"' + sel('custom', tagProvider) + '>第一个自定义接口</option>' +
      '</select>'),
    '<div class="flexbar"><button class="btn primary" id="vcSave">保存识图设置</button><span class="mut" id="vcHint" style="font-size:12px"></span></div>',
    '<details class="advanced-box" style="margin-top:12px"><summary><b>自定义识图接口</b> <span class="pill">' + customs.length + ' 个</span><span class="mut" style="font-size:12px;margin-left:8px">点开添加 / 管理</span></summary>',
    '<div class="mut" style="font-size:12px;margin:8px 0 6px">填 OpenAI 兼容地址（例如 https://api.openai.com/v1），Key 只保存在本机 data 目录。</div>',
    customRows,
    row('名称', '<input id="vpName" placeholder="例如 OpenAI / 本地 Ollama">'),
    row('接口地址', '<input id="vpBase" placeholder="https://你的服务/v1">'),
    row('API Key', '<input id="vpKey" type="password" placeholder="sk-...">'),
    row('模型名', '<input id="vpModel" placeholder="例如 gpt-4o-mini（可稍后检测再选）">'),
    '<div class="flexbar"><button class="btn" id="vpAdd">添加自定义接口</button><span class="mut" id="vpHint" style="font-size:12px"></span></div>',
    '</details>',
    '</div></details>'
  ].join('')
}
function selfCheckCard(){
  const info = selfCheckInfo
  const rows = (info && info.items ? info.items : []).map(function(x){
    return '<div class="frow"><label>' + esc(x.label) + '</label><div>' + (x.ok ? '✅' : '❌') + ' <span class="mut">' + esc(x.detail || '') + '</span></div></div>'
  }).join('')
  return '<section class="card"><h2>自检 ' + (info ? (info.failed ? '<span class="pill" style="background:#a33;color:#fff">' + info.failed + ' 项异常</span>' : '<span class="pill">全部正常</span>') : '') + '</h2>' +
    (rows || '<div class="mut">点下面按钮运行一次自检</div>') +
    '<div class="flexbar"><button class="btn" id="runSelfcheck">重新检查</button></div></section>'
}
function backupCard(){
  const items = (backupInfo.items || []).slice(0, 7)
  const rows = items.map(function(x){ return '<tr><td class="mono">' + esc(x.name) + '</td><td>' + (x.size / 1024 / 1024).toFixed(1) + ' MB</td><td style="text-align:right"><button class="btn sm" data-restore="' + esc(x.name) + '">还原</button> <button class="btn sm" data-delbackup="' + esc(x.name) + '">删除</button></td></tr>' }).join('')
  return '<section class="card"><h2>备份</h2><div class="note">每天自动备份一次，保留最近 7 份。位置：' + esc(backupInfo.root || 'data/backups') + '</div>' +
    (rows ? '<table class="tbl"><thead><tr><th>备份</th><th>大小</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="mut">还没有备份</div>') +
    '<div class="flexbar"><button class="btn primary" id="doBackup">立即备份</button></div></section>'
}
function svgChart(list, series, { mode = 'line', height = 160, percent = false } = {}){
  const w = 580, padL = 34, padR = 10, padT = 12, padB = 24
  const innerW = w - padL - padR, innerH = height - padT - padB
  const maxRaw = Math.max(0, ...list.flatMap(function(d){ return series.map(function(s){ return s.get(d) || 0 }) }))
  // 取“好看”的整数上限：1/2/5 × 10^n；百分比至少留到 100，超过 100 时跟着放大
  const niceMax = function(v){
    if (!(v > 0)) return 1
    const exp = Math.pow(10, Math.floor(Math.log10(v)))
    const n = v / exp
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * exp
  }
  const max = percent ? niceMax(Math.max(100, maxRaw)) : niceMax(maxRaw * 1.05)
  const step = list.length > 1 ? innerW / (list.length - 1) : innerW
  const x = function(i){ return padL + (list.length > 1 ? i * step : innerW / 2) }
  const y = function(v){ return Math.max(padT, Math.min(padT + innerH, padT + innerH - ((Number(v) || 0) / max) * innerH)) }
  const grid = [0, 0.25, 0.5, 0.75, 1].map(function(r){
    const yy = padT + innerH * (1 - r)
    return '<line x1="' + padL + '" y1="' + yy + '" x2="' + (w - padR) + '" y2="' + yy + '" stroke="rgba(148,163,184,.18)" stroke-width="1"></line>' +
      '<text x="' + (padL - 6) + '" y="' + (yy + 3) + '" font-size="10" text-anchor="end" fill="#9aabc0">' + Math.round(max * r) + (percent ? '%' : '') + '</text>'
  }).join('')
  const labelEvery = Math.max(1, Math.ceil(list.length / 7))
  const labels = list.map(function(d, i){
    if (i % labelEvery !== 0 && i !== list.length - 1) return ''
    return '<text x="' + x(i) + '" y="' + (height - 6) + '" font-size="10" text-anchor="middle" fill="#9aabc0">' + esc(d.date.slice(5)) + '</text>'
  }).join('')
  const paths = series.map(function(s){
    if (mode === 'bar') {
      const bw = Math.max(4, Math.min(18, innerW / Math.max(1, list.length) / (series.length + 1)))
      const idx = series.indexOf(s)
      return list.map(function(d, i){
        const v = s.get(d) || 0
        const bx = x(i) - (series.length * bw) / 2 + idx * bw
        return '<rect x="' + bx + '" y="' + y(v) + '" width="' + bw + '" height="' + Math.max(0, padT + innerH - y(v)) + '" fill="' + s.color + '" rx="2"><title>' + esc(d.date + ' ' + s.name + '：' + v) + '</title></rect>'
      }).join('')
    }
    const points = list.map(function(d, i){ return x(i) + ',' + y(s.get(d) || 0) }).join(' ')
    const area = list.length > 1 ? 'M' + x(0) + ',' + (padT + innerH) + ' L' + list.map(function(d, i){ return x(i) + ',' + y(s.get(d) || 0) }).join(' L') + ' L' + x(list.length - 1) + ',' + (padT + innerH) + ' Z' : ''
    return (s.fill ? '<path d="' + area + '" fill="' + s.color + '" opacity="0.10"></path>' : '') +
      '<polyline points="' + points + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round"></polyline>'
  }).join('')
  const legend = series.map(function(s){ return '<span style="margin-right:14px"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + s.color + ';margin-right:5px"></i>' + esc(s.name) + '</span>' }).join('')
  return '<div class="mut" style="font-size:12px;margin-bottom:4px">' + legend + '</div><svg viewBox="0 0 ' + w + ' ' + height + '" style="width:100%;height:auto">' + grid + paths + labels + '</svg>'
}
function downloadText(filename, text, type){
  const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(function(){ URL.revokeObjectURL(url) }, 1000)
}
function memoryMarkdown(data){
  const lines = ['# 记忆导出', '', '导出时间：' + new Date(data.exportedAt || Date.now()).toLocaleString(), '']
  const mem = data.memory || {}, long = data.longMemory || {}
  const keys = Array.from(new Set(Object.keys(mem).concat(Object.keys(long))))
  for (const k of keys) {
    lines.push('## ' + k, '')
    const l = long[k]
    if (l && l.summary) lines.push('### 长期记忆', '', l.summary, '')
    const rows = mem[k] || []
    if (rows.length) {
      lines.push('### 近期消息（' + rows.length + ' 条）', '')
      for (const m of rows) lines.push('- [' + (m.time ? new Date(m.time).toLocaleString() : '') + '] ' + m.role + '：' + String(m.content || '').replace(/\n/g, ' '))
      lines.push('')
    }
  }
  return lines.join('\n')
}
function metricsCsv(list){
  const head = ['date', 'received', 'replied', 'skipped', 'errors', 'stickers', 'searches', 'llmCount', 'llmMs', 'groups']
  const rows = (list || []).map(function(d){ return head.map(function(k){ return d[k] == null ? 0 : d[k] }).join(',') })
  return head.join(',') + '\n' + rows.join('\n')
}
function pageMetrics(){
  const list = metricsInfo || []
  const sum = function(k){ return list.reduce(function(n, d){ return n + (Number(d[k]) || 0) }, 0) }
  const received = sum('received'), replied = sum('replied'), errors = sum('errors')
  const rate = received ? Math.round(replied / received * 100) : 0
  const fail = received ? Math.round(errors / received * 100) : 0
  const avg = sum('llmCount') ? (sum('llmMs') / sum('llmCount') / 1000).toFixed(1) : '—'
  const rangeBtns = [[7, '7 天'], [14, '14 天'], [30, '30 天']].map(function(x){
    return '<button class="btn sm' + (metricsRange === x[0] ? ' primary' : '') + '" data-mrange="' + x[0] + '">' + x[1] + '</button>'
  }).join(' ')
  const chartCard = function(title, inner){ return '<details class="card"><summary><b class="api-card-title">' + title + '</b> <span class="api-card-meta">点开查看</span></summary><div class="api-card-body">' + inner + '</div></details>' }
  return '<h1>运行概览</h1><div class="sub">按天统计，用来判断机器人是"在正常工作"还是"在空转"；数据每 30 秒落盘。</div>' +
    '<div class="flexbar">' + rangeBtns + '<button class="btn" id="metricsCsv" style="margin-left:auto">导出 CSV</button></div>' +
    '<div class="grid g3">' +
      '<div class="card"><h3>收到消息</h3><div class="kpi">' + received + '</div><div class="note">' + list.length + ' 天合计</div></div>' +
      '<div class="card"><h3>已回复</h3><div class="kpi">' + replied + '</div><div class="note">回复率 ' + rate + '%</div></div>' +
      '<div class="card"><h3>错误</h3><div class="kpi">' + errors + '</div><div class="note">占收到的 ' + fail + '%</div></div>' +
      '<div class="card"><h3>表情包</h3><div class="kpi">' + sum('stickers') + '</div><div class="note">发送次数</div></div>' +
      '<div class="card"><h3>联网搜索</h3><div class="kpi">' + sum('searches') + '</div><div class="note">调用次数</div></div>' +
      '<div class="card"><h3>跳过未回复</h3><div class="kpi">' + sum('skipped') + '</div><div class="note">跳过率 ' + (received ? Math.round(sum('skipped') / received * 100) : 0) + '%</div></div>' +
      '<div class="card"><h3>模型调用</h3><div class="kpi">' + sum('llmCount') + '</div><div class="note">生成次数</div></div>' +
      '<div class="card"><h3>平均生成耗时</h3><div class="kpi">' + avg + 's</div><div class="note">模型端到端</div></div>' +
    '</div>' +
    chartCard('消息与回复', svgChart(list, [
      { name: '收到', color: '#3b6ea5', get: function(d){ return d.received } },
      { name: '已回复', color: '#4aa3a3', get: function(d){ return d.replied } }
    ], { mode: 'bar' })) +
    chartCard('回复率 / 跳过率 / 错误率', svgChart(list, [
      { name: '回复率', color: '#4aa3a3', get: function(d){ return d.received ? d.replied / d.received * 100 : 0 }, fill: true },
      { name: '跳过率', color: '#b8860b', get: function(d){ return d.received ? d.skipped / d.received * 100 : 0 } },
      { name: '错误率', color: '#d9534f', get: function(d){ return d.received ? d.errors / d.received * 100 : 0 } }
    ], { mode: 'line', percent: true })) +
    chartCard('表情包与搜索', svgChart(list, [
      { name: '表情包发送', color: '#b8860b', get: function(d){ return d.stickers } },
      { name: '联网搜索', color: '#7a5cd6', get: function(d){ return d.searches } }
    ], { mode: 'bar' })) +
    chartCard('活跃群数', svgChart(list, [
      { name: '有消息的群', color: '#7a5cd6', get: function(d){ return d.groups || 0 }, fill: true }
    ], { mode: 'line' })) +
    chartCard('模型调用次数', svgChart(list, [
      { name: '生成次数', color: '#3b6ea5', get: function(d){ return d.llmCount || 0 } }
    ], { mode: 'bar' })) +
    chartCard('平均生成耗时（秒）', svgChart(list, [
      { name: '平均耗时', color: '#4aa3a3', get: function(d){ return d.llmCount ? d.llmMs / d.llmCount / 1000 : 0 }, fill: true }
    ], { mode: 'line' }))
}
function pageErrors(){
  const items = errorInfo || []
  const rows = items.map(function(e){
    const warn = e.level === 'warn'
    const color = warn ? '#c9973b' : '#e05555'
    return '<div style="padding:10px 0 10px 10px;border-bottom:1px dashed rgba(148,163,184,.2);border-left:3px solid ' + color + '">' +
      '<div class="mut" style="font-size:12px;display:flex;gap:8px;align-items:center">' +
      '<span style="display:inline-block;padding:1px 8px;border-radius:999px;background:' + color + ';color:#fff;font-size:11px">' + (warn ? '警告' : '错误') + '</span>' +
      esc(new Date(e.time).toLocaleString()) + ' · ' + esc(e.scope || 'bot') + '</div>' +
      '<pre class="mono" style="white-space:pre-wrap;word-break:break-all;margin:6px 0;font-size:12px;color:' + (warn ? 'var(--text)' : color) + '">' + esc(e.message || '') + '</pre></div>'
  }).join('')
  return '<h1>错误中心</h1><div class="sub">最近 ' + items.length + ' 条错误或警告；后台任务可能延迟或暂停，请查看具体原因。</div>' +
    '<div class="flexbar"><button class="btn" id="errorsRefresh">刷新</button><button class="btn" id="errorsClear">清空</button></div>' +
    (rows || '<div class="card mut">还没有错误记录</div>')
}
function tasksCard(){
  const t = tasksInfo
  if (!t) return ''
  const fmt = function(ts){ return ts ? new Date(ts).toLocaleString() : '还没有' }
  return '<details class="card"><summary><b class="api-card-title">定时任务</b> <span class="api-card-meta">不占地方</span></summary><div class="api-card-body">' +
    '<div class="frow"><label>自动备份</label><div class="mut">每 6 小时检查，最近：' + esc(fmt(t.backup && t.backup.last)) + '</div></div>' +
    '<div class="frow"><label>群总结</label><div class="mut">' + (t.summary && t.summary.enabled ? '已启用 · 每天 ' + esc(t.summary.times) : '未启用') + '</div></div>' +
    '<div class="frow"><label>长期记忆整理</label><div class="mut">' + (t.longMemory && t.longMemory.enabled ? '每 ' + t.longMemory.everyMinutes + ' 分钟' : '未启用') + '</div></div>' +
    '<div class="frow"><label>表情包学习</label><div class="mut">' + (t.stickersLearn && t.stickersLearn.enabled ? '每小时最多 ' + t.stickersLearn.perHour + ' 张' : '未启用') + '</div></div>' +
    '</div></details>'
}
function commandTestCard(){
  return '<section class="card"><h2>指令测试台</h2><div class="note">输入一句话，看会命中哪条指令、会回什么；<b>不会真的发送</b>，也不调用 AI。</div>' +
    '<div class="flexbar"><input id="ctText" placeholder="例如：/help 或 早安" style="flex:1;min-width:200px"><select id="ctWhere"><option value="group">群里</option><option value="private">私聊</option></select><button class="btn" id="ctRun">测试</button></div>' +
    '<div id="ctResult" style="margin-top:10px"></div></section>'
}
function pageSelfCheck(){
  return '<h1>自检</h1><div class="sub">检查机器人能不能正常跑：Key、连接、目录、磁盘、备份与记忆文件。</div>' + selfCheckCard() + tasksCard()
}
function pageStickers(){
  const items = stickerList || []
  const sceneList = stickerScenes || []
  const learn = stickerLearn || {}
  const settings = stickerSettings || {}
  const groupMap = new Map(joinedGroups.map(g => [String(g.id), { id: String(g.id), name: g.name }]))
  chats.filter(c => c.type === 'group').forEach(g => {
    const id=String(g.id),joined=groupMap.get(id)
    if (!joined?.name || joined.name === id) groupMap.set(id,g)
  })
  ;[...(learn.groups || []),...(settings.groups || [])].forEach(id => { if (!groupMap.has(String(id))) groupMap.set(String(id), { id: String(id), name: '已指定群' }) })
  const groups = [...groupMap.values()].map(g=>({ ...g, name: !g.name || String(g.name).replace(/\s+/g,'') === '群'+g.id || String(g.name) === String(g.id) ? '群聊' : g.name }))
  const gopts = groups.map(function(g){ return '<option value="' + g.id + '">' + esc(g.name) + '（' + g.id + '）</option>' }).join('')
  const sceneChoices = sceneList.map(function(sc){
    return '<label style="font-size:12px;margin-right:10px;white-space:nowrap"><input type="checkbox" data-up-scene value="' + esc(sc.id) + '">' + esc(sc.name) + '</label>'
  }).join('')
  const cards = items.map(function(s){
    const scenes = s.scenes || []
    const boxes = sceneList.map(function(sc){
      const on = scenes.indexOf(sc.id) >= 0
      return '<label style="font-size:12px;margin-right:8px;white-space:nowrap"><input type="checkbox" data-scene-item="' + esc(s.id) + '" value="' + esc(sc.id) + '"' + (on ? ' checked' : '') + '>' + esc(sc.name) + '</label>'
    }).join('')
    const badge = s.origin === 'learned' ? '<span class="pill" style="background:#2a7;color:#fff">学习</span>' : ''
    return '<article data-stk-card="' + esc(s.id) + '" style="border:1px solid var(--line,#ddd);border-radius:14px;padding:16px;flex:1 1 300px;min-width:260px;max-width:420px">' +
      '<button class="btn" data-stk-preview="' + esc(s.id) + '" style="width:100%;padding:0" aria-label="预览 ' + esc(s.name) + '"><img data-stk-thumb="' + esc(s.id) + '" src="/api/sticker-file?id=' + encodeURIComponent(s.id) + '&scope=' + encodeURIComponent(stickerPersona?.token || '') + '&hash=' + encodeURIComponent(s.hash || '') + '" style="width:100%;height:180px;object-fit:contain;border-radius:10px;background:#0002" alt="' + esc(s.name) + '"></button>' +
      '<div style="margin:10px 0">' + badge + ' <b style="font-size:15px">' + esc(s.name) + '</b> <span class="mut">' + Math.ceil((s.size || 0)/1024) + ' KB · 用过 ' + (s.usage || 0) + ' 次</span></div>' +
      '<details style="margin-top:6px" data-stk-detail="' + esc(s.id) + '"' + (stickerCardOpen.has(String(s.id)) ? ' open' : '') + '><summary style="cursor:pointer">详情 / 编辑</summary>' +
      '<label>名称<input data-stk-name="' + esc(s.id) + '" value="' + esc(s.name) + '" maxlength="40" style="width:100%;margin:6px 0"></label>' +
      '<label>标签<input data-stk-kw="' + esc(s.id) + '" value="' + esc((s.keywords || []).join(' ')) + '" placeholder="空格或逗号分隔" style="width:100%;margin:6px 0"></label>' +
      '<label>描述<textarea data-stk-desc="' + esc(s.id) + '" maxlength="1000" rows="3" placeholder="画面内容、适合什么时候用；会供模型参考" style="width:100%;margin:6px 0">' + esc(s.description || '') + '</textarea></label>' +
      '<details style="margin:8px 0"><summary>适用场景</summary><div style="line-height:1.8">' + boxes + '</div></details>' +
      '<label>替换图片<input data-stk-file="' + esc(s.id) + '" type="file" accept="image/png,image/jpeg,image/webp,image/gif" style="width:100%;margin:6px 0"></label><div class="mut">选择后点击保存；保留条目，重新计算哈希。最多4MB。</div>' +
      '<label style="display:block;margin-top:8px">SHA-256<input readonly data-stk-hash="' + esc(s.id) + '" value="' + esc(s.hash || '') + '" style="width:100%;font-family:monospace;font-size:12px;margin:6px 0"></label>' +
      '<div class="flexbar"><button class="btn primary" data-stk-save="' + esc(s.id) + '">保存修改</button><button class="btn" data-stk-copy="' + esc(s.id) + '">复制哈希</button><button class="btn" data-stk-del="' + esc(s.id) + '">仅删除</button><button class="btn" data-stk-block="' + esc(s.id) + '">拉入黑名单并删除</button></div>' +
      '</details></article>'
  }).join('')
  return [
    '<h1>表情包</h1><div class="flexbar" style="margin:8px 0"><button class="btn" id="retagAll">一键生成标签</button><button class="btn" id="retagMissing">只补缺失标签</button><span class="mut" id="retagHint"></span></div><p class="note">当前图库：' + esc(stickerPersona?.name || '默认人格') + ' · 图库、标签、使用记录和黑名单按人格分开；自动学习与配图跟随会话人格。切换后不会混用，原图库保留。</p><div class="sub">给每张图起名、打关键词和语境；机器人按语境挑图，模型也能用 [贴纸: 名称] 点名要。</div>',
    '<details class="card" data-stkfold="rules"' + (stickerFold.rules ? ' open' : '') + '><summary><b class="api-card-title">发送规则</b> <span class="api-card-meta">概率 ' + Math.round(settings.autoRate ?? 35) + '% · 每次最多 ' + (settings.maxPerReply || 1) + ' 张</span></summary><div class="api-card-body">',
    '<label style="display:flex;align-items:center;gap:8px;font-size:14px"><input type="checkbox" id="stkEnabled"' + (settings.enabled !== false ? ' checked' : '') + '> 启用表情包（关闭后模型不会发图）</label>',
    '<div class="note">表情包必须跟随已成功发送的普通聊天文字回复。用户明确要求发表情包时直接尝试发送，不抽概率；普通聊天的自动配图（含模型主动选图）遵守下方概率；名称或标签按匹配程度加权抽图，同名同分机会相等；没有匹配候选时不随机补图。仍遵守开关、范围、黑名单及冷却；群总结、指令回执和 /Q 解题不自动配图。</div>',
    '<label style="display:block;margin:12px 0">文字回复配图概率 <input id="stkAutoRange" type="range" min="0" max="100" value="' + (settings.autoRate ?? 35) + '"> <input id="stkAutoRate" type="number" min="0" max="100" value="' + (settings.autoRate ?? 35) + '" style="width:90px"> %</label>',
    '<div class="mut">自动配图默认35%；0关闭自动配图，100每次尝试。明确索图不受此概率限制；彻底禁用请关闭总开关。按整轮文字回复判断一次，不是每一行。</div>',
    '<label style="display:block;margin:12px 0">每次最多 <input id="stkMax" type="number" min="1" max="3" value="' + (settings.maxPerReply || 1) + '" style="width:90px"> 张</label>',
    '<label style="display:block;margin:12px 0">选图方式 <select id="stkPickMode">' + [['context','模型按语境选图，情绪接近即可'],['model','模型候选按匹配程度加权选图'],['random','随机选图']].map(x=>'<option value="'+x[0]+'"'+((settings.pickMode || 'context')===x[0]?' selected':'')+'>'+x[1]+'</option>').join('') + '</select></label>',
    '<label style="display:block;margin:12px 0">发送范围 <select id="stkSendScope">' + [['all','所有已允许回复的会话'],['whitelist','仅白名单群'],['selected','仅指定群'],['private','仅私聊']].map(x=>'<option value="'+x[0]+'"'+((settings.scope || 'all')===x[0]?' selected':'')+'>'+x[1]+'</option>').join('') + '</select></label>',
    '<div id="stkSendGroups"' + (settings.scope === 'selected' ? '' : ' hidden') + '>' + groups.map(g=>'<label style="display:block;margin:8px 0"><input type="checkbox" data-stk-send-group="'+esc(g.id)+'"'+((settings.groups || []).map(String).includes(String(g.id))?' checked':'')+'> '+esc(g.name)+' ('+esc(g.id)+')</label>').join('') + '<div class="mut">留空不配图；这些设置不会扩大机器人原本允许回复的范围。</div></div>',
    '<label style="display:block;margin:12px 0">同一会话配图间隔 <input id="stkCooldown" type="number" min="0" max="86400" value="' + (settings.cooldownSeconds || 0) + '" style="width:100px"> 秒（0不额外限制）</label>',
    '<button class="btn primary" id="stkRulesSave">保存发送规则</button>',
    '</div></details>',
    '<details class="card" data-stkfold="learn"' + (stickerFold.learn ? ' open' : '') + '><summary><b class="api-card-title">自动学习</b> <span class="api-card-meta">群 ' + ((learn.groups || []).length) + ' 个 · 私聊 ' + (learn.private ? '已开' : '未开') + '</span></summary><div class="api-card-body">',
    '<div class="mut" style="margin-top:6px">DeepSeek Flash 初筛，Qwen 复核并打标签；无法确认的图不收录。已学习 ' + (stickerLearned || 0) + ' 张 / 共 ' + items.length + ' / ' + (learn.limit || 60) + ' 张。</div>',
    '<div class="note">每个人格图库最多60张（含手动上传）；满库自动停止学习，清理到60张以下后需手动重新开启。' + (learn.pausedByCapacity ? '当前已因容量停止学习。' : '') + '</div>',
    '<details class="learn-box"><summary><b>群聊学习</b> <span class="pill">' + ((learn.groups || []).length) + ' 个群</span></summary>',
    '<label class="switch sticker-learn-switch"><input type="checkbox" role="switch" id="stkLearnToggle"' + (learn.enabled ? ' checked' : '') + (learn.full ? ' disabled' : '') + '><i aria-hidden="true"></i><span>启用群聊表情包学习</span></label>',
    '<div class="note">只学习下面勾选的群，可选非白名单群；不改变聊天回复范围。</div>',
    '<input id="stkLearnSearch" placeholder="搜索群名或群号" style="width:100%;margin:8px 0">',
    '<div id="stkLearnGroupList" style="max-height:220px;overflow:auto">' + (groups || []).map(function(g) { return '<label style="display:block;margin:6px 0"><input type="checkbox" data-stk-learn-group="' + esc(g.id) + '"' + ((learn.groups || []).map(String).includes(String(g.id)) ? ' checked' : '') + '> ' + esc(g.name || '群聊') + '（' + esc(g.id) + '）</label>' }).join('') + '</div>',
    '</details>',
    '<details class="learn-box"><summary><b>私聊学习</b> <span class="pill">' + (learn.private ? '已开启' : '未开启') + '</span></summary>',
    '<label class="switch sticker-learn-switch"><input type="checkbox" role="switch" id="stkLearnPrivate"' + (learn.private && learn.enabled ? ' checked' : '') + (learn.full ? ' disabled' : '') + '><i aria-hidden="true"></i><span>私聊里发来的图片也收藏</span></label>',
    '<div class="note">开启后，所有和机器人私聊的人发来的图片都会尝试收藏；仍受每小时上限约束。群聊与私聊可以单独开关。</div>',
    '</details>',
    '<div class="row" style="margin-top:8px;display:flex;gap:8px;align-items:center">',
    '<span class="mut">每小时最多</span><input id="stkLearnPerHour" type="number" min="0" max="60" value="' + (learn.perHour || 0) + '" style="width:90px"><span class="mut">张</span>',
    '<button class="btn" id="stkLearnSave">保存学习设置</button>',
    '</div></details>',
    '<p class="note">活动图库容量：' + items.length + ' / 60 张；手动导入也占名额。满库后请先删除或拉黑不需要的图片。</p>',
    window.StickerUploadUI?.render(sceneList) || '',
    '<details class="card" data-stkfold="manual"' + (stickerFold.manual ? ' open' : '') + '><summary><b class="api-card-title">手动发送</b> <span class="api-card-meta">文字 + 表情包</span></summary><div class="api-card-body"><div class="note">这里会真实发送到所选群；手动发送不抽取概率，但同样必须有伴随文字。</div>',
    '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap">',
    '<select id="stkSendGroup">' + (gopts || '<option value="">没有群可发</option>') + '</select>',
    '<input id="stkSendText" placeholder="必填：伴随文字" maxlength="1000" style="flex:1;min-width:160px">',
    '<input id="stkSendKw" placeholder="留空 = 随机一张" style="flex:1;min-width:160px">',
    '<button class="btn" id="stkSend">发送</button>',
    '</div></details>',
    '<details class="card" data-stkfold="blacklist"' + (stickerFold.blacklist ? ' open' : '') + '><summary><b class="api-card-title">黑名单</b> <span class="api-card-meta">' + stickerBlacklist.length + ' 张</span></summary><div class="api-card-body"><div class="note">这些图片不会被学习或发送。解除后允许重新学习或上传，不会自动放回表情包库。按原图哈希识别；重新压缩或裁剪后的图片不视为同一张。</div><input id="stkBlockedSearch" placeholder="搜索黑名单名称、标签、描述或哈希" aria-label="搜索表情包黑名单" style="width:100%;margin-bottom:16px">' + (stickerBlacklist.length ? '<div style="display:flex;flex-wrap:wrap;gap:12px">'+stickerBlacklist.map(s=>'<article data-stk-blocked-card="'+esc(s.hash)+'" style="border:1px solid var(--line,#ddd);border-radius:14px;padding:16px;flex:1 1 300px;min-width:260px;max-width:420px">'+
      (s.hasPreview?'<button class="btn" data-stk-blocked-preview="'+esc(s.hash)+'" style="width:100%;padding:0" aria-label="预览黑名单 '+esc(s.name)+'"><img loading="lazy" src="/api/sticker-blacklist-file?hash='+encodeURIComponent(s.hash)+'&scope='+encodeURIComponent(stickerPersona?.token || '')+'" alt="'+esc(s.name)+'" style="width:100%;height:180px;object-fit:contain;border-radius:10px;background:#0002"></button>':'<div style="height:180px;display:grid;place-content:center;text-align:center;border-radius:10px;background:#0002"><strong>暂无图片预览</strong><span class="mut">旧版图片已删除，黑名单仍然有效</span></div>')+
      '<div style="margin:10px 0"><span class="pill">已屏蔽</span> <span class="mut">'+(s.blockedAt?esc(new Date(s.blockedAt).toLocaleString()):'记录时间未知')+'</span></div><h3>'+esc(s.name||'未命名表情包')+'</h3>'+
      ((s.keywords||[]).length?'<div class="mut">标签：'+esc(s.keywords.join(' · '))+'</div>':'')+(s.description?'<p>'+esc(s.description)+'</p>':'')+
      '<details style="margin:12px 0"><summary>查看 SHA-256</summary><input readonly aria-label="黑名单哈希" value="'+esc(s.hash)+'" style="width:100%;font-family:monospace;font-size:12px;margin:8px 0"></details><div class="flexbar"><button class="btn primary" data-stk-unblock="'+esc(s.hash)+'">解除黑名单</button><button class="btn" data-stk-blocked-copy="'+esc(s.hash)+'">复制哈希</button></div></article>').join('')+'</div><div id="stkBlockedEmpty" class="mut" hidden>没有匹配的黑名单图片</div>' : '<div class="mut">暂无黑名单</div>') + '</div></details>',
    '<details class="card" data-stkfold="similar"' + (stickerFold.similar ? ' open' : '') + '><summary><b class="api-card-title">相似图检测</b> <span class="api-card-meta">找出重复收录</span></summary><div class="api-card-body"><div class="note">按图片指纹比较，重新压缩或裁剪过的近似图也能找出来；只提示，不会自动删。</div><div class="flexbar"><button class="btn" id="simRun">开始检测</button></div><div id="simList"></div></div></details>',
    '<details class="card" data-stkfold="library"' + (stickerFold.library ? ' open' : '') + '><summary><b class="api-card-title">表情包库</b> <span class="api-card-meta">' + items.length + ' 张</span></summary><div class="api-card-body"><input id="stkSearch" placeholder="搜索名称、标签、描述或哈希" style="width:100%;margin-bottom:16px">',
    items.length ? ('<div style="display:flex;flex-wrap:wrap;gap:12px">' + cards + '</div>') : '<div class="mut">还没有表情包，先上传几张，或者打开上面的群聊学习。</div>',
    '</div></details>',
    '<dialog id="stkPreviewDialog" style="max-width:90vw;max-height:90vh;background:var(--card,#15243a);color:inherit;border:1px solid #567;border-radius:16px;padding:20px"><h2 id="stkPreviewTitle"></h2><img id="stkPreviewImage" style="display:block;max-width:80vw;max-height:65vh;object-fit:contain" alt="表情包预览"><button class="btn" id="stkPreviewClose">关闭预览</button></dialog>'
  ].join('')
}
function detailKey(d){
  const s = d.querySelector('summary')
  return s ? String(s.textContent || '').replace(/\s+/g, '').replace(/\d+/g, '#') : ''
}
function captureOpenDetails(){
  const out = []
  document.querySelectorAll('#main details').forEach(function(d){
    if (!d.open) return
    const k = detailKey(d)
    if (k) out.push(k)
  })
  return out
}
function restoreOpenDetails(list){
  if (!list || !list.length) return
  const want = new Set(list)
  document.querySelectorAll('#main details').forEach(function(d){
    const k = detailKey(d)
    if (k && want.has(k)) d.open = true
  })
}
function render(){
  const main = document.getElementById('main')
  const keepOpen = captureOpenDetails()
  let html = ''
  if (page === 'overview') html = pageOverview()
  else if (page === 'chats') html = pageChats()
  else if (page === 'commands') html = pageCommands()
  else if (page === 'persona') html = pagePersona()
  else if (page === 'humanize') html = pageHumanize()
  else if (page === 'api') html = pageApi()
  else if (page === 'report') html = pageReport()
  else if (page === 'memory') html = pageMemory()
  else if (page === 'stickers') html = pageStickers()
  else if (page === 'metrics') html = pageMetrics()
  else if (page === 'selfcheck') html = pageSelfCheck()
  else if (page === 'errors') html = pageErrors()
  else if (page === 'logs') html = pageLogs()
  else html = pageMemory()
  main.innerHTML = html
  restoreOpenDetails(keepOpen)
  bind().catch(e => toast('界面初始化失败：' + e.message, true))
  if (page === 'logs') refreshLogs()
  if (page === 'report' || page === 'memory') loadDaily()
}

async function bind(){
  refreshSummaryControls()
  const checkUpdate=document.getElementById('checkUpdate');if(checkUpdate)checkUpdate.onclick=()=>refreshUpdates(true)
  if(page==='stickers'){
    stickerControlsDirty=false
    document.querySelectorAll('[data-stkfold]').forEach(function(el){
      el.addEventListener('toggle', function(){ stickerFold[el.dataset.stkfold] = el.open })
    })
    document.querySelectorAll('[data-stk-detail]').forEach(function(el){
      el.addEventListener('toggle', function(){
        if (el.open) stickerCardOpen.add(String(el.dataset.stkDetail))
        else stickerCardOpen.delete(String(el.dataset.stkDetail))
      })
    })
    const learnSearch = document.getElementById('stkLearnSearch')
    if (learnSearch) learnSearch.oninput = function(){
      const q = learnSearch.value.trim().toLowerCase()
      document.querySelectorAll('#stkLearnGroupList label').forEach(function(l){ l.style.display = l.textContent.toLowerCase().includes(q) ? '' : 'none' })
    }
    document.querySelectorAll('#stkEnabled,#stkAutoRange,#stkAutoRate,#stkMax,#stkPickMode,#stkSendScope,#stkCooldown,#stkLearnToggle,#stkLearnPrivate,#stkLearnPerHour,[data-stk-send-group],[data-stk-learn-group]').forEach(el=>el.addEventListener('input',()=>{stickerControlsDirty=true}))
  }
  const cleanGroups = document.getElementById('cleanGroups')
  if (cleanGroups) cleanGroups.onclick = async function(){
    if (!await ask('清理非白名单群？', '会把不在白名单里的群从会话列表移除，并清空它们的记忆、会话设置和日报文件；执行前完整备份，备份失败则停止。', '清理')) return
    cleanGroups.disabled = true
    try {
      const r = await api('/api/action/cleanup-groups', {})
      toast(r.removed && r.removed.length ? ('已清理 ' + r.removed.length + ' 个：' + r.removed.join('、')) : '没有需要清理的群')
      await load()
    } catch(e) { toast('清理失败：' + e.message, true) }
    finally { cleanGroups.disabled = false }
  }
  // 联网搜索：开关 + 模型，保存后即时重建，不用重启
  const wsSave = document.getElementById('wsSave')
  if (wsSave) wsSave.onclick = async function(){
    wsSave.disabled = true
    try {
      const chosen=document.getElementById('wsModel').value
      const r = await api('/api/action/set-websearch', { enabled: document.getElementById('wsEnabled').checked, model: chosen })
      webSearchInfo = { enabled: r.enabled, model: r.model, provider: r.provider }
      toast('已保存：' + (r.enabled ? '允许联网' : '关闭联网') + '，模型 ' + r.model)
      await load()
    } catch(e) { toast('保存失败：' + e.message, true) }
    finally { wsSave.disabled = false }
  }
  document.querySelectorAll('[data-apicard]').forEach(el => {
    el.addEventListener('toggle', () => { apiCardsOpen[el.dataset.apicard] = el.open })
  })
  const exportMemory = document.getElementById('exportMemory')
  if (exportMemory) exportMemory.onclick = async function(){
    try {
      const data = await api('/api/memory-export')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const now = new Date(); const pad = function(n){ return String(n).padStart(2,'0') }
      const a = document.createElement('a')
      a.href = url
      a.download = 'koukou-memory-' + now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate()) + '.json'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(function(){ URL.revokeObjectURL(url) }, 1000)
      toast('已导出记忆文件')
    } catch(e){ toast('导出失败：' + e.message, true) }
  }
  const memSearch = document.getElementById('memSearch')
  if (memSearch) memSearch.oninput = function(){
    const q = memSearch.value.trim().toLowerCase()
    document.querySelectorAll('#memList .mem-day').forEach(function(day){
      if (q) day.open = true
      let visible = 0
      day.querySelectorAll('[data-mem-row]').forEach(function(row){
        const hit = !q || row.textContent.toLowerCase().includes(q)
        row.style.display = hit ? '' : 'none'
        if (hit) visible += 1
      })
      day.style.display = visible ? '' : 'none'
    })
  }
  const personaCheck = document.getElementById('personaCheck')
  if (personaCheck) personaCheck.onclick = async function(){
    const box = document.getElementById('personaCheckResult')
    personaCheck.disabled = true
    try {
      const r = await api('/api/action/persona-check', {})
      if (box) box.textContent = r.warnings.length ? ('发现 ' + r.warnings.length + ' 条：' + r.warnings.join('；')) : ('未发现明显矛盾（' + r.length + ' 字，' + r.lines + ' 段）')
      toast(r.warnings.length ? '发现 ' + r.warnings.length + ' 条可疑表述' : '未发现明显矛盾')
    } catch(e){ toast('检查失败：' + e.message, true) }
    finally { personaCheck.disabled = false }
  }
  const errorsRefresh = document.getElementById('errorsRefresh')
  if (errorsRefresh) errorsRefresh.onclick = async function(){
    errorInfo = (await api('/api/errors').catch(function(){ return { items: [] } })).items || []
    pokeReplies = (await api('/api/poke-replies').catch(function(){ return { lines: [] } })).lines || []
    await loadPythonScripts()
    render()
  }
  const errorsClear = document.getElementById('errorsClear')
  if (errorsClear) errorsClear.onclick = async function(){
    if (!await ask('清空错误记录？', '只清空显示历史，不影响机器人运行。', '清空')) return
    await api('/api/action/clear-errors', {})
    errorInfo = []
    render()
  }
  const ctRun = document.getElementById('ctRun')
  if (ctRun) ctRun.onclick = async function(){
    const text = document.getElementById('ctText').value.trim()
    const box = document.getElementById('ctResult')
    if (!text) { box.innerHTML = '<div class="mut">先输入一句话</div>'; return }
    ctRun.disabled = true
    try {
      const r = await api('/api/action/test-command', { text, isPrivate: document.getElementById('ctWhere').value === 'private' })
      const parts = []
      if (r.builtin) parts.push('<div><b>内置：' + esc(r.builtin.name) + '</b> <span class="pill">' + (r.builtin.enabled ? (r.builtin.allowed ? '可执行' : '被权限/范围挡住') : '已关闭') + '</span></div>')
      if (r.custom.length) for (const c of r.custom) parts.push('<div style="margin-top:6px"><b>自定义：' + esc(c.name) + '</b> <span class="mut">触发词 ' + esc(c.trigger) + '</span><pre class="mono" style="white-space:pre-wrap;margin:4px 0">' + esc(c.reply) + '</pre></div>')
      if (!parts.length) parts.push('<div class="mut">没有命中任何指令，会走普通聊天。</div>')
      box.innerHTML = parts.join('')
    } catch(e){ box.innerHTML = '<div class="mut">测试失败：' + esc(e.message) + '</div>' }
    finally { ctRun.disabled = false }
  }
  const exportMemoryMd = document.getElementById('exportMemoryMd')
  if (exportMemoryMd) exportMemoryMd.onclick = async function(){
    try {
      const data = await api('/api/memory-export')
      const now = new Date(); const pad = function(n){ return String(n).padStart(2,'0') }
      downloadText('koukou-memory-' + now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate()) + '.md', memoryMarkdown(data), 'text/markdown;charset=utf-8')
      toast('已导出 Markdown')
    } catch(e){ toast('导出失败：' + e.message, true) }
  }
  const metricsCsvBtn = document.getElementById('metricsCsv')
  if (metricsCsvBtn) metricsCsvBtn.onclick = function(){
    downloadText('koukou-metrics-' + metricsRange + 'd.csv', metricsCsv(metricsInfo), 'text/csv;charset=utf-8')
    toast('已导出 CSV')
  }
  const retagMissing = document.getElementById('retagMissing')
  if (retagMissing) retagMissing.onclick = async function(){
    const hint = document.getElementById('retagHint')
    retagMissing.disabled = true
    try {
      const r = await stickerApi('/api/action/retag-stickers', { onlyMissing: true })
      if (hint) hint.textContent = '待补 ' + r.total + ' 张…'
      const timer = setInterval(async function(){
        try {
          const st = await api('/api/stickers/retag-status?scope='+encodeURIComponent(boundStickerScope || ''))
          if (hint) hint.textContent = st.running ? ('补标中 ' + st.done + '/' + st.total) : ('完成 ' + st.done + '/' + st.total + '，跳过 ' + (st.skipped || 0) + '，失败 ' + st.errors + (st.cancelled ? '（人格切换已取消）' : ''))
          if (!st.running) { clearInterval(timer); retagMissing.disabled = false; await load() }
        } catch(e){ clearInterval(timer); retagMissing.disabled = false }
      }, 2000)
    } catch(e){ toast('启动失败：' + e.message, true); retagMissing.disabled = false }
  }
  const memoryImport = document.getElementById('memoryImport')
  if (memoryImport) memoryImport.onchange = async function(){
    const file = memoryImport.files && memoryImport.files[0]
    if (!file) return
    if (!await ask('导入记忆？', '会先用当前数据做一份备份，然后覆盖文件里同名会话的记忆。', '导入')) { memoryImport.value = ''; return }
    try {
      const data = JSON.parse(await file.text())
      const r = await api('/api/action/memory-import', { data })
      toast('已导入：近期 ' + r.recentKeys + ' 个会话，长期 ' + r.longKeys + ' 个')
      await load()
    } catch(e){ toast('导入失败：' + e.message, true) }
    finally { memoryImport.value = '' }
  }
  const simRun = document.getElementById('simRun')
  if (simRun) simRun.onclick = async function(){
    const box = document.getElementById('simList')
    simRun.disabled = true
    if (box) box.innerHTML = '<div class="mut">正在计算图片指纹…</div>'
    try {
      const r = await stickerApi('/api/action/detect-similar', {})
      if (!box) return
      if (!r.groups.length) { box.innerHTML = '<div class="mut">检查了 ' + r.checked + ' 张，没有发现相似图</div>'; return }
      box.innerHTML = '<div class="mut" style="margin:8px 0">检查 ' + r.checked + ' 张，发现 ' + r.groups.length + ' 组相似</div>' + r.groups.map(function(g){
        const fig = function(x){
          return '<figure style="margin:0;text-align:center"><img src="/api/sticker-file?id=' + encodeURIComponent(x.id) + '&scope=' + encodeURIComponent(stickerPersona?.token || '') + '" style="width:110px;height:110px;object-fit:contain;border-radius:10px;background:#0002"><figcaption class="mut" style="font-size:12px;margin:4px 0">' + esc(x.name) + '</figcaption><button class="btn sm" data-simdel="' + esc(x.id) + '">删这张</button></figure>'
        }
        return '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 0;border-bottom:1px dashed rgba(148,163,184,.2)">' + fig(g.a) + '<span class="mut">≈</span>' + fig(g.b) + '<span class="mut" style="font-size:12px">差异 ' + g.distance + '</span></div>'
      }).join('')
      box.querySelectorAll('[data-simdel]').forEach(function(b){
        b.onclick = async function(){
          if (!await ask('删除这张表情包？', '删除后不可恢复，可以重新上传。', '删除')) return
          try { await api('/api/action/sticker-delete', { id: b.dataset.simdel }); b.closest('figure').remove(); toast('已删除') }
          catch(e){ toast('删除失败：' + e.message, true) }
        }
      })
    } catch(e){ if (box) box.innerHTML = '<div class="mut">检测失败：' + esc(e.message) + '</div>' }
    finally { simRun.disabled = false }
  }
  const pyImport = document.getElementById('pyImport')
  if (pyImport) pyImport.onchange = async function(){
    syncPyOpen()
    const file = pyImport.files && pyImport.files[0]
    if (!file) return
    try {
      const content = await file.text()
      await api('/api/action/import-python-script', { filename: file.name, content })
      toast('已导入：' + file.name)
      await load(); render()
    } catch(e){ toast('导入失败：' + e.message, true) }
    finally { pyImport.value = '' }
  }
  document.querySelectorAll('[data-pydel]').forEach(function(b){
    b.onclick = async function(){
      if (!await ask('删除脚本 ' + b.dataset.pydel + '？', '会同时删除备份文件 .bak。', '删除')) return
      syncPyOpen()
      const did = b.dataset.pydel
      pyOpen.rows = pyOpen.rows.filter(function(x){ return x !== did })
      pyOpen.editors = pyOpen.editors.filter(function(x){ return x !== did })
      try { await api('/api/action/delete-python-script', { id: did }); toast('已删除'); await load(); render() }
      catch(e){ toast('删除失败：' + e.message, true) }
    }
  })
  document.querySelectorAll('[data-pytoggle]').forEach(function(b){
    b.onclick = async function(){
      const id = b.dataset.pytoggle
      const on = b.dataset.next === '1'
      b.disabled = true
      try {
        await api('/api/action/toggle-python-script', { id: id, enabled: on })
        // 就地更新，不触发整页重绘，展开状态自然不会丢
        b.dataset.next = on ? '0' : '1'
        b.textContent = on ? '停用' : '启用'
        const row = b.closest('details')
        const sum = row ? row.querySelector('summary') : null
        if (sum) {
          let pill = sum.querySelector('.pill')
          if (on) { if (pill) pill.remove() }
          else if (!pill) { pill = document.createElement('span'); pill.className = 'pill'; pill.textContent = '已停用'; sum.appendChild(pill) }
        }
        const it = (pythonScripts || []).find(function(x){ return x.id === id })
        if (it) it.enabled = on
        toast((on ? '已启用 ' : '已停用 ') + id)
      } catch(e){ toast('操作失败：' + e.message, true) }
      finally { b.disabled = false }
    }
  })
  document.querySelectorAll('[data-pyedit]').forEach(function(b){
    b.onclick = async function(){
      const id = b.dataset.pyedit
      const box = document.getElementById('pyEditor-' + id)
      if (!box) return
      if (box.style.display !== 'none') { box.style.display = 'none'; pyOpen.editors = pyOpen.editors.filter(function(x){ return x !== id }); return }
      if (pyOpen.editors.indexOf(id) < 0) pyOpen.editors.push(id)
      try {
        const r = await api('/api/action/read-python-script', { id })
        box.querySelector('[data-pysrc]').value = r.content || ''
        box.style.display = ''
      } catch(e){ toast('读取失败：' + e.message, true) }
    }
  })
  document.querySelectorAll('[data-pysave]').forEach(function(b){
    b.onclick = async function(){
      const id = b.dataset.pysave
      const box = document.getElementById('pyEditor-' + id)
      const msg = document.getElementById('pyMsg-' + id)
      b.disabled = true
      try {
        await api('/api/action/import-python-script', { filename: id + '.py', content: box.querySelector('[data-pysrc]').value })
        if (msg) msg.textContent = '已保存'
        toast('已保存 ' + id + '.py')
      } catch(e){ if (msg) msg.textContent = '保存失败：' + e.message; toast('保存失败：' + e.message, true) }
      finally { b.disabled = false }
    }
  })
  document.querySelectorAll('[data-pycancel]').forEach(function(b){
    b.onclick = function(){
      const cid = b.dataset.pycancel
      const box = document.getElementById('pyEditor-' + cid)
      if (box) box.style.display = 'none'
      pyOpen.editors = pyOpen.editors.filter(function(x){ return x !== cid })
    }
  })
  const pyRecallSave = document.getElementById('pyRecallSave')
  if (pyRecallSave) pyRecallSave.onclick = async function(){
    const hint = document.getElementById('pyRecallHint')
    try {
      const r = await api('/api/action/save-python-settings', { recallSeconds: Number(document.getElementById('pyRecall').value) })
      pythonSettings = r.settings || pythonSettings
      if (hint) hint.textContent = '已保存：' + pythonSettings.recallSeconds + ' 秒'
      toast('默认撤回已设为 ' + pythonSettings.recallSeconds + ' 秒')
    } catch(e){ if (hint) hint.textContent = e.message; toast('保存失败：' + e.message, true) }
  }
  const pyDraftBtn = document.getElementById('pyDraftBtn')
  if (pyDraftBtn) pyDraftBtn.onclick = async function(){
    const hint = document.getElementById('pyDraftHint')
    const prompt = document.getElementById('pyPrompt').value.trim()
    if (!prompt) { if (hint) hint.textContent = '先写一句需求'; return }
    if (hint) hint.textContent = '生成中…'
    try {
      const r = await api('/api/action/draft-python-script', { prompt })
      document.getElementById('pyNewCode').value = r.content || ''
      const nameInput = document.getElementById('pyNewName')
      if (!nameInput.value.trim()) nameInput.value = r.filename || 'new.py'
      const who = r.model ? ('由 ' + r.model + ' 生成') : '草稿已生成'
      if (hint) hint.textContent = who + (r.warnings && r.warnings.length ? ('；注意：' + r.warnings.join('；')) : '；确认后保存')
    } catch(e){ if (hint) hint.textContent = '生成失败：' + e.message }
  }
  const pyTplBtn = document.getElementById('pyTplBtn')
  if (pyTplBtn) pyTplBtn.onclick = function(){
    document.getElementById('pyNewCode').value = [
      '# name: 新脚本',
      '# desc: 一句话说明这个脚本做什么',
      '# usage: /py 新脚本 参数',
      '# admin: true',
      '# cmd: 参数 | 说明',
      'import sys',
      '',
      'args = sys.argv[1:]',
      "if not args:",
      "    print('用法：/py 新脚本 参数')",
      '    sys.exit(1)',
      '',
      "print('收到：' + ' '.join(args))",
      ''
    ].join('\n')
    const nameInput = document.getElementById('pyNewName')
    if (!nameInput.value.trim()) nameInput.value = 'new.py'
  }
  const pyNewClear = document.getElementById('pyNewClear')
  if (pyNewClear) pyNewClear.onclick = function(){
    document.getElementById('pyPrompt').value = ''
    document.getElementById('pyNewCode').value = ''
    document.getElementById('pyNewName').value = ''
    document.getElementById('pyDraftHint').textContent = ''
    document.getElementById('pyNewHint').textContent = ''
  }
  const pyNewSave = document.getElementById('pyNewSave')
  if (pyNewSave) pyNewSave.onclick = async function(){
    syncPyOpen()
    const hint = document.getElementById('pyNewHint')
    const name = document.getElementById('pyNewName').value.trim()
    const code = document.getElementById('pyNewCode').value
    if (!name) { if (hint) hint.textContent = '请填文件名，例如 wc.py'; return }
    if (!code.trim()) { if (hint) hint.textContent = '代码是空的'; return }
    try {
      await api('/api/action/import-python-script', { filename: name, content: code })
      const cmdInput = document.getElementById('pyNewCmd')
      const id = name.replace(/\.py$/i, '')
      let cmd = id
      if (cmdInput && cmdInput.value.trim()) {
        const r = await api('/api/action/set-python-command', { id, command: cmdInput.value.trim() })
        cmd = r.command
      }
      if (hint) hint.textContent = '已保存：' + name + '（调用名 /py ' + cmd + '）'
      toast('已保存 ' + name + '，用 /py ' + cmd + ' 调用')
      await load(); render()
    } catch(e){ if (hint) hint.textContent = '保存失败：' + e.message; toast('保存失败：' + e.message, true) }
  }
  document.querySelectorAll('[data-pyopen]').forEach(function(b){
    b.onclick = async function(){
      const id = b.dataset.pyopen || ''
      try {
        const r = await api('/api/action/open-python-folder', id ? { id } : {})
        if (r && r.ok === false) toast('打不开资源管理器：' + (r.error || '未知原因') + '；可点前面「复制路径」再 Win+R 粘贴', true)
        else if (r && r.warning) toast(r.warning + '：' + r.path)
        else toast('已打开：' + (r.path || ''))
      } catch(e){ toast('打开失败：' + e.message, true) }
    }
  })
  document.querySelectorAll('[data-pycopy]').forEach(function(b){
    b.onclick = async function(){
      const text = b.dataset.pycopy || ''
      if (!text) { toast('没有可复制的路径', true); return }
      try { await navigator.clipboard.writeText(text); toast('已复制：' + text) }
      catch(e){ toast('复制失败，请手动选择路径', true) }
    }
  })
  const pyCardEl = document.querySelector('details[data-pycard]')
  if (pyCardEl) pyCardEl.addEventListener('toggle', function(){ pyOpen.card = pyCardEl.open })
  document.querySelectorAll('details[data-pyrow]').forEach(function(d){
    d.addEventListener('toggle', function(){
      const rid = d.dataset.pyrow
      if (d.open) { if (pyOpen.rows.indexOf(rid) < 0) pyOpen.rows.push(rid) }
      else { pyOpen.rows = pyOpen.rows.filter(function(x){ return x !== rid }); pyOpen.editors = pyOpen.editors.filter(function(x){ return x !== rid }) }
    })
  })
  pyOpen.editors.slice().forEach(function(eid){
    const box = document.getElementById('pyEditor-' + eid)
    if (!box) return
    const ta = box.querySelector('[data-pysrc]')
    box.style.display = ''
    if (ta && !ta.value) api('/api/action/read-python-script', { id: eid }).then(function(r){ ta.value = r.content || '' }).catch(function(){})
  })
  document.querySelectorAll('[data-pycmdsave]').forEach(function(b){
    b.onclick = async function(){
      syncPyOpen()
      const id = b.dataset.pycmdsave
      const input = document.querySelector('[data-pycmd="' + id + '"]')
      try {
        const r = await api('/api/action/set-python-command', { id, command: input ? input.value : '' })
        toast('调用名已改为 /py ' + r.command)
        await load(); render()
      } catch(e){ toast('保存失败：' + e.message, true) }
    }
  })
  const pokeSave = document.getElementById('pokeSave')
  if (pokeSave) pokeSave.onclick = async function(){
    const box = document.getElementById('pokeText')
    const hint = document.getElementById('pokeHint')
    pokeSave.disabled = true
    try {
      const r = await api('/api/action/save-poke-replies', { text: box.value })
      pokeReplies = box.value.split(/\r?\n/).map(function(s){ return s.trim() }).filter(function(s){ return s && s[0] !== '#' })
      if (hint) hint.textContent = '已保存 ' + r.count + ' 条，立即生效'
      toast('拍一拍语库已更新：' + r.count + ' 条')
    } catch(e){ toast('保存失败：' + e.message, true) }
    finally { pokeSave.disabled = false }
  }
  const retagAll = document.getElementById('retagAll')
  if (retagAll) retagAll.onclick = async function(){
    const hint = document.getElementById('retagHint')
    retagAll.disabled = true
    try {
      const r = await stickerApi('/api/action/retag-stickers', {})
      if (hint) hint.textContent = '开始处理 ' + r.total + ' 张…'
      const timer = setInterval(async function(){
        try {
          const st = await api('/api/stickers/retag-status?scope='+encodeURIComponent(boundStickerScope || ''))
          if (hint) hint.textContent = st.running ? ('处理中 ' + st.done + '/' + st.total + '，跳过 ' + (st.skipped || 0) + '，失败 ' + st.errors + (st.cancelled ? '（人格切换已取消）' : '')) : ('完成 ' + st.done + '/' + st.total + '，跳过 ' + (st.skipped || 0) + '，失败 ' + st.errors + (st.cancelled ? '（人格切换已取消）' : ''))
          if (!st.running) { clearInterval(timer); retagAll.disabled = false; await load() }
        } catch(e) { clearInterval(timer); retagAll.disabled = false }
      }, 2000)
    } catch(e){ toast('启动失败：' + e.message, true); retagAll.disabled = false }
  }
  document.querySelectorAll('[data-restore]').forEach(function(b){
    b.onclick = async function(){
      if (!await ask('还原到 ' + b.dataset.restore + '？', '会先备份当前数据，并固定选中的备份副本；重启后在读取记忆前应用还原。必须与备份使用同一人格。', '还原')) return
      b.disabled = true
      try {
        const r = await api('/api/action/restore-backup', { name: b.dataset.restore })
        toast('还原任务已准备：' + r.restored + '，正在重启后应用…')
        await api('/api/action/restart-bot', {})
      } catch(e){ toast('还原失败：' + e.message, true); b.disabled = false }
    }
  })
  document.querySelectorAll('[data-delbackup]').forEach(function(b){
    b.onclick = async function(){
      if (!await ask('删除备份 ' + b.dataset.delbackup + '？', '只删这一份备份文件，当前记忆和配置不受影响。', '删除')) return
      b.disabled = true
      try {
        await api('/api/action/delete-backup', { name: b.dataset.delbackup })
        backupInfo = await api('/api/backups')
        toast('已删除备份')
        render()
      } catch(e){ toast('删除失败：' + e.message, true); b.disabled = false }
    }
  })
  const doBackup = document.getElementById('doBackup')
  if (doBackup) doBackup.onclick = async function(){
    doBackup.disabled = true
    try { const r = await api('/api/action/backup', {}); toast('已备份：' + r.name); await load() }
    catch(e){ toast('备份失败：' + e.message, true) }
    finally { doBackup.disabled = false }
  }
  const runSelfcheck = document.getElementById('runSelfcheck')
  if (runSelfcheck) runSelfcheck.onclick = async function(){
    runSelfcheck.disabled = true
    try { selfCheckInfo = await api('/api/selfcheck'); render() }
    catch(e){ toast('自检失败：' + e.message, true) }
    finally { runSelfcheck.disabled = false }
  }
  document.querySelectorAll('[data-mrange]').forEach(function(b){
    b.onclick = async function(){
      metricsRange = Number(b.dataset.mrange) || 7
      metricsInfo = (await api('/api/metrics?days=' + metricsRange).catch(function(){ return { items: [] } })).items || []
      render()
    }
  })
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const act = b.dataset.act
    if (act === 'summary') { await doSummary(); return }
    const prompts = {
      'restart-bot': ['重启机器人？', '机器人会短暂离线，然后由计划任务重新启动。', '重启'],
      'restart-napcat': ['重启 NapCat？', 'QQ 连接会中断一会儿，机器人在恢复连接后继续工作。', '重启'],
      'daily-ping': ['立即发送定时指令？', '这会立刻以机器人身份发送 @示例机器人 指令。', '发送'],
    }
    if (prompts[act] && !await ask(...prompts[act])) return
    b.disabled = true
    try { const r = await api('/api/action/' + act, {}); toast('已执行：' + act + (r.needRestart ? '（需重启）' : '')) }
    catch(e){ toast('失败：' + e.message, true) }
    b.disabled = false
  })

  // 折叠
  document.querySelectorAll('.chat .head').forEach(h => h.onclick = (ev) => {
    if (ev.target.closest('button')) return
    const box = h.parentElement
    box.classList.toggle('open')
    const k = box.dataset.key
    box.classList.contains('open') ? openChats.add(k) : openChats.delete(k)
  })
  // 滑块实时显示
  document.querySelectorAll('[data-f]').forEach(el => {
    if (el.type === 'range') el.oninput = () => {
      const s = el.closest('.body')?.querySelector('[data-show="' + el.dataset.f + '"]')
      if (s) s.textContent = (el.value*100).toFixed(0) + '%'
    }
  })
  // 沿用全局勾选后禁用输入
  document.querySelectorAll('[data-global]').forEach(cb => {
    const f = cb.dataset.global
    const sync = () => {
      const targets = document.querySelectorAll(`.chat .body [data-f="${f}"]`)
      targets.forEach(t => {
        if (t.closest('.chat').dataset.key !== cb.closest('.chat').dataset.key) return
        t.disabled = cb.checked
        t.style.opacity = cb.checked ? .45 : 1
      })
    }
    cb.onchange = sync; sync()
  })
  // 保存会话
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const box = b.closest('.chat'), key = b.dataset.save
    const q = (f) => box.querySelector(`[data-f="${f}"]`)
    const isGlobal = (f) => { const c = box.querySelector(`[data-global="${f}"]`); return c ? c.checked : false }
    const patch = {
      enabled: q('enabled').checked,
      atReplyEnabled: q('atReplyEnabled').checked,
      ...proactiveSettingsPatch(box),
      emojiKeepRate: isGlobal('emojiKeepRate') ? null : Number(q('emojiKeepRate').value),
      replyMaxLines: isGlobal('replyMaxLines') ? null : Number(q('replyMaxLines').value),
      lineMaxChars: isGlobal('replyMaxLines') ? null : Number(q('lineMaxChars').value),
      quietHours: isGlobal('quietHours') ? null : q('quietHours').value,
      note: q('note').value,
      customPrompt: q('customPrompt').value,
      persona: (q('persona') && q('persona').value) || '',
    }
    try { const r = await api('/api/action/set-chat', { key, patch }); toast('已保存并即时生效' + (r.memoryReset ? '，本会话旧记忆已备份并重置' : '')); await load() }
    catch(e){ toast('保存失败：' + e.message, true) }
  })
  // 盯人目标：设置 / 取消
  document.querySelectorAll('[data-watch]').forEach(el => el.onclick = async () => {
    const key = el.dataset.watch
    const gid = key.slice(1)
    const on = isWatching(gid)
    try {
      if (on) {
        if (!await ask('取消盯人目标？', '取消后机器人不再主动接这个群指定群友的话。', '取消盯人')) return
        await api('/api/action/watch-target', { key, enabled: false })
        toast('已取消盯人')
      } else {
        const uid = await ask('设置盯人目标', '填要盯的 QQ 号：他在这个群说话时，机器人会主动接一句。', '保存', true)
        if (!uid) return
        await api('/api/action/watch-target', { key, userId: uid.trim() })
        toast('已设置盯人目标')
      }
      await load()
    } catch (e) { toast('操作失败：' + e.message, true) }
  })
  // 工作台：管理员编辑（写入 ADMIN_USERS，立刻生效）
  const adminSaveBtn = document.getElementById('adminUsersSave')
  if (adminSaveBtn) adminSaveBtn.onclick = async () => {
    const input = document.getElementById('adminUsersInput')
    const value = input.value.split(',').map(s => s.trim()).filter(Boolean).join(',')
    adminSaveBtn.disabled = true
    try {
      await api('/api/action/set-config', { key: 'ADMIN_USERS', value })
      await load()
      toast('管理员已保存，立刻生效')
    } catch (e) { toast('保存失败：' + e.message, true) }
    adminSaveBtn.disabled = false
  }
  if(page === 'commands') CommandCenterUI.bind({api,toast,load,render,ask})
  // 识图设置：多自定义接口 / 检测 / 保存
  const vcProvider = document.getElementById('vcProvider')
  const vcModel = document.getElementById('vcModel')
  const vcDetect = document.getElementById('vcDetect')
  const vcDetectHint = document.getElementById('vcDetectHint')
  const visionModelCache = {}
  const customOf = function(provider){
    const list = (state?.config?.visionProviders) || []
    const id = String(provider).startsWith('custom:') ? String(provider).slice(7) : ''
    return list.find(function(x){ return x.id === id }) || null
  }
  const modelOf = function(provider){
    const s = state?.config || {}
    if (String(provider).startsWith('custom:')) return (customOf(provider) || {}).model || ''
    if (provider === 'deepseek') return s.visionModelDeepseek || ''
    if (provider === 'dashscope') return s.visionModelDashscope || ''
    return ''
  }
  const fillVisionModels = function(models, current){
    if (!vcModel) return
    const list = (models && models.length) ? models.slice() : []
    if (current && list.indexOf(current) < 0) list.unshift(current)
    vcModel.innerHTML = list.length
      ? list.map(function(id){ return '<option value="' + esc(id) + '"' + (id === current ? ' selected' : '') + '>' + esc(id) + '</option>' }).join('')
      : '<option value="">（先点自动检测）</option>'
  }
  if (vcProvider) {
    vcProvider.onchange = function(){
      const p = vcProvider.value
      const cur = modelOf(p)
      fillVisionModels(visionModelCache[p] || [], cur)
      if (vcDetectHint) vcDetectHint.textContent = visionModelCache[p] ? ('已缓存 ' + visionModelCache[p].length + ' 个型号') : (String(p).startsWith('custom:') ? '自定义：点检测拿型号列表' : '点「自动检测模型」拿型号列表')
    }
  }
  if (vcDetect) vcDetect.onclick = async function(){
    const provider = vcProvider.value
    vcDetect.disabled = true
    if (vcDetectHint) vcDetectHint.textContent = '检测中…'
    try {
      const r = await api('/api/action/detect-vision-models', { provider: provider })
      const ids = (r.models || []).map(function(m){ return m.id })
      visionModelCache[provider] = ids
      fillVisionModels(ids, vcModel.value || modelOf(provider))
      if (vcDetectHint) vcDetectHint.textContent = '检测到 ' + r.count + ' 个型号；列表不保证识图能力，请选多模态型号'
    } catch (e) {
      if (vcDetectHint) vcDetectHint.textContent = '检测失败：' + e.message
      toast('检测失败：' + e.message, true)
    }
    vcDetect.disabled = false
  }
  const vcSave = document.getElementById('vcSave')
  if (vcSave) vcSave.onclick = async function(){
    const hint = document.getElementById('vcHint')
    const provider = vcProvider.value
    const model = vcModel.value.trim()
    vcSave.disabled = true
    try {
      const patch={VISION_PROVIDER:provider,STICKER_TAG_PROVIDER:document.getElementById('vcTag').value,VISION_REASONING:(document.getElementById('vcReasoning')||{}).value||'none',VISION_MAX_TOKENS:String((document.getElementById('vcTokens')||{}).value||300)}
      if (String(provider).startsWith('custom:')) {
        const id = String(provider).slice(7)
        if (model) await api('/api/action/vision-provider-update', { id: id, model: model })
      } else if (model) {
        const key = provider === 'deepseek' ? 'VISION_MODEL' : 'DASHSCOPE_MODEL'
        patch[key]=model
      }
      await api('/api/action/set-config-batch', {patch})
      await load()
      if (hint) hint.textContent = '已保存并生效'
      toast('识图设置已保存')
    } catch (e) { toast('保存失败：' + e.message, true) }
    vcSave.disabled = false
  }
  const vpAdd = document.getElementById('vpAdd')
  if (vpAdd) vpAdd.onclick = async function(){
    const hint = document.getElementById('vpHint')
    vpAdd.disabled = true
    try {
      await api('/api/action/vision-provider-add', {
        name: document.getElementById('vpName').value, baseUrl: document.getElementById('vpBase').value,
        apiKey: document.getElementById('vpKey').value, model: document.getElementById('vpModel').value,
      })
      await load()
      toast('已添加自定义接口')
    } catch (e) { if (hint) hint.textContent = '添加失败：' + e.message; toast('添加失败：' + e.message, true) }
    vpAdd.disabled = false
  }
  document.querySelectorAll('[data-vp-del]').forEach(function(el){ el.onclick = async function(){
    if (!await ask('删除这个自定义接口？', '只删本地保存的地址和 Key，不影响服务商账号。', '删除')) return
    try { await api('/api/action/vision-provider-delete', { id: el.dataset.vpDel }); await load(); toast('已删除') }
    catch (e) { toast('删除失败：' + e.message, true) }
  }})
  // 工作台：识图模型切换
  const quickVision = document.getElementById('quickVision')
  if (quickVision) quickVision.onchange = async () => {
    const target = quickVision.value
    const prev = state?.config?.visionProvider || 'deepseek'
    if (target === 'custom' && !state?.config?.visionCustomReady) {
      toast('自定义识图还没配置好，请到「模型与接口 → 识图设置」填写地址和 Key', true)
      quickVision.value = prev
      return
    }
    try {
      await api('/api/action/set-config', { key: 'VISION_PROVIDER', value: target })
      await load()
      const label = target === 'dashscope' ? '通义千问' : target.startsWith('custom') ? '自定义识图' : 'DeepSeek'
      toast('识图已切换到 ' + label)
    } catch (e) {
      quickVision.value = prev
      toast('切换失败：' + e.message, true)
    }
  }
  // 工作台快捷开关
  const quickTiming = document.getElementById('quickTiming')
  if (quickTiming) quickTiming.onchange = async () => {
    try {
      await api('/api/action/set-config', { key: 'REPLY_TIMING_ENABLED', value: quickTiming.checked ? '1' : '0' })
      await load()
      toast(quickTiming.checked ? '已开启耗时显示' : '已关闭耗时显示')
    } catch (e) { toast('保存失败：' + e.message, true) }
  }
  // 模型：供应商预填 / 自动检测 / 下拉即生效
  const mpProvider = document.getElementById('mpProvider')
  if (mpProvider) mpProvider.onchange = () => {
    const p = (modelsInfo.providers || []).find(x => x.id === mpProvider.value)
    const base = document.getElementById('mpBaseUrl')
    if (p && p.baseUrl && base) base.value = p.baseUrl
  }
  const mpDetect = document.getElementById('mpDetect')
  if (mpDetect) mpDetect.onclick = async () => {
    const baseUrl = document.getElementById('mpBaseUrl').value.trim()
    const apiKey = document.getElementById('mpKey').value.trim()
    const hint = document.getElementById('mpHint')
    mpDetect.disabled = true
    if (hint) hint.textContent = '检测中…'
    try {
      const r = await api('/api/action/detect-models', { baseUrl, apiKey })
      modelsAvailable = (r.models || []).map(x => x.id)
      try { localStorage.setItem('koukou_models', JSON.stringify(modelsAvailable)) } catch (e) {}
      const sel = document.getElementById('mpModel')
      const cur = document.getElementById('mpModel')?.value || modelsInfo.current?.model || ''
      if (sel) {
        sel.innerHTML = modelsAvailable.map(function(id){ return '<option value="' + esc(id) + '">' + esc(id) + '</option>' }).join('')
        if (modelsAvailable.indexOf(cur) >= 0) sel.value = cur
      }
      if (hint) hint.textContent = '检测到 ' + r.count + ' 个型号，直接在上面下拉里选'
    } catch (e) {
      if (hint) hint.textContent = '检测失败：' + e.message
      toast('检测失败：' + e.message, true)
    }
    mpDetect.disabled = false
  }
  const mpSaveBase = document.getElementById('mpSaveBase')
  if (mpSaveBase) mpSaveBase.onclick = async () => {
    const baseUrl = document.getElementById('mpBaseUrl').value.trim()
    const key = document.getElementById('mpKey').value.trim()
    const provider = document.getElementById('mpProvider').value
    mpSaveBase.disabled = true
    try {
      await api('/api/action/set-config', { key: 'MODEL_PROVIDER', value: provider })
      if (baseUrl) await api('/api/action/set-config', { key: 'DEEPSEEK_BASE_URL', value: baseUrl })
      if (key) await api('/api/action/set-config', { key: 'DEEPSEEK_API_KEY', value: key })
      await load()
      toast('地址与密钥已保存')
    } catch (e) { toast('保存失败：' + e.message, true) }
    mpSaveBase.disabled = false
  }
  const mpModel = document.getElementById('mpModel')
  if (mpModel) mpModel.onchange = async () => {
    const value = mpModel.value
    if (!value) return
    try {
      await api('/api/action/set-config', { key: 'DEEPSEEK_MODEL', value })
      const st = document.getElementById('mpStatus')
      const m = modelsInfo.current || {}
      if (st) st.textContent = '当前：' + (m.provider || '-') + ' · ' + value + ' · 思考 ' + (m.reasoning || '默认')
      toast('已切换到 ' + value)
    } catch (e) { toast('切换失败：' + e.message, true) }
  }
  const mpReason = document.getElementById('mpReason')
  if (mpReason) mpReason.onchange = async () => {
    try {
      await api('/api/action/set-config', { key: 'DEEPSEEK_REASONING_EFFORT', value: mpReason.value })
      const st = document.getElementById('mpStatus')
      const m = modelsInfo.current || {}
      if (st) st.textContent = '当前：' + (m.provider || '-') + ' · ' + (m.model || '-') + ' · 思考 ' + (mpReason.value || '默认')
      toast('思考强度已设为 ' + (mpReason.value || '默认'))
    } catch (e) { toast('设置失败：' + e.message, true) }
  }
  // 表情包：学习开关 / 上传 / 保存 / 删除 / 测试发送
  const stkRulesSave=document.getElementById('stkRulesSave')
  const probability=document.getElementById('stkAutoRate'),range=document.getElementById('stkAutoRange')
  if(probability&&range){range.oninput=()=>{probability.value=range.value};probability.oninput=()=>{range.value=probability.value}}
  const sendScope=document.getElementById('stkSendScope')
  if(sendScope)sendScope.onchange=()=>{document.getElementById('stkSendGroups').hidden=sendScope.value!=='selected'}
  if(stkRulesSave)stkRulesSave.onclick=async()=>{
    const ids=['stkAutoRate','stkMax','stkCooldown'];if(ids.some(id=>!document.getElementById(id).value.trim()||!document.getElementById(id).checkValidity())){toast('请检查概率、张数和间隔范围',true);return}
    stkRulesSave.disabled=true
    try{
      await api('/api/action/set-config-batch',{patch:{STICKERS_ENABLED:document.getElementById('stkEnabled').checked?'1':'0',STICKER_AUTO_RATE:probability.value,STICKER_MAX_PER_REPLY:document.getElementById('stkMax').value,STICKER_PICK_MODE:document.getElementById('stkPickMode').value,STICKER_SEND_SCOPE:sendScope.value,STICKER_SEND_GROUPS:Array.from(document.querySelectorAll('[data-stk-send-group]:checked')).map(x=>x.dataset.stkSendGroup).join(','),STICKER_COOLDOWN_SECONDS:document.getElementById('stkCooldown').value}})
      await load();toast('发送规则已保存，立即生效')
    }catch(e){toast('保存失败：'+e.message,true)}finally{stkRulesSave.disabled=false}
  }
  const stkLearnSave = document.getElementById('stkLearnSave')
  if(stkLearnSave)stkLearnSave.onclick=async()=>{
    stkLearnSave.disabled=true
    try{
      await api('/api/action/set-config', { key: 'STICKER_LEARN_PRIVATE', value: (document.getElementById('stkLearnPrivate')?.checked ? '1' : '0') })
      await api('/api/action/set-config-batch',{patch:{STICKER_LEARN_ENABLED:document.getElementById('stkLearnToggle').checked?'1':'0',STICKER_LEARN_GROUPS:Array.from(document.querySelectorAll('[data-stk-learn-group]:checked')).map(x=>x.dataset.stkLearnGroup).join(','),STICKER_LEARN_PER_HOUR:document.getElementById('stkLearnPerHour').value}})
      await load();toast('学习设置已保存，立即生效')
    }catch(e){toast('保存失败：'+e.message,true)}finally{stkLearnSave.disabled=false}
  }
  const stkSearch=document.getElementById('stkSearch')
  if(stkSearch)stkSearch.oninput=()=>{const q=stkSearch.value.trim().toLowerCase();document.querySelectorAll('[data-stk-card]').forEach(el=>{const s=stickerList.find(s=>s.id===el.dataset.stkCard);el.hidden=![s?.name,...(s?.keywords || []),s?.description,s?.hash].join(' ').toLowerCase().includes(q)})}
  const blockedSearch=document.getElementById('stkBlockedSearch')
  if(blockedSearch)blockedSearch.oninput=()=>{const q=blockedSearch.value.trim().toLowerCase();let count=0;document.querySelectorAll('[data-stk-blocked-card]').forEach(el=>{const s=stickerBlacklist.find(s=>s.hash===el.dataset.stkBlockedCard);el.hidden=![s?.name,...(s?.keywords||[]),s?.description,s?.hash].join(' ').toLowerCase().includes(q);if(!el.hidden)count++});const empty=document.getElementById('stkBlockedEmpty');if(empty)empty.hidden=count>0}
  document.querySelectorAll('[data-stk-blocked-preview]').forEach(el=>el.onclick=()=>{const s=stickerBlacklist.find(s=>s.hash===el.dataset.stkBlockedPreview);document.getElementById('stkPreviewTitle').textContent='黑名单 · '+s.name;document.getElementById('stkPreviewImage').src='/api/sticker-blacklist-file?hash='+encodeURIComponent(s.hash)+'&scope='+encodeURIComponent(stickerPersona?.token || '');document.getElementById('stkPreviewDialog').showModal()})
  document.querySelectorAll('[data-stk-blocked-copy]').forEach(el=>el.onclick=async()=>{try{await navigator.clipboard.writeText(el.dataset.stkBlockedCopy);toast('哈希已复制')}catch{toast('可展开哈希手动复制',true)}})
  document.querySelectorAll('[data-stk-preview]').forEach(el=>el.onclick=()=>{const s=stickerList.find(s=>s.id===el.dataset.stkPreview);document.getElementById('stkPreviewTitle').textContent=s.name;document.getElementById('stkPreviewImage').src='/api/sticker-file?id='+encodeURIComponent(s.id)+'&scope='+encodeURIComponent(stickerPersona?.token || '')+'&hash='+encodeURIComponent(s.hash || '');document.getElementById('stkPreviewDialog').showModal()})
  const previewClose=document.getElementById('stkPreviewClose');if(previewClose)previewClose.onclick=()=>document.getElementById('stkPreviewDialog').close()
  document.querySelectorAll('[data-stk-copy]').forEach(el=>el.onclick=async()=>{try{await navigator.clipboard.writeText(stickerList.find(s=>s.id===el.dataset.stkCopy).hash);toast('哈希已复制')}catch(e){toast('可在哈希输入框中手动复制',true)}})
  document.querySelectorAll('[data-stk-file]').forEach(el=>el.onchange=()=>{const f=el.files[0];if(!f)return;if(f.size>4*1024*1024){toast('图片不能超过4MB',true);el.value='';return}const r=new FileReader();r.onload=()=>{document.querySelector('[data-stk-thumb="'+el.dataset.stkFile+'"]').src=r.result};r.readAsDataURL(f)})
  const boundStickerScope=stickerPersona?.token
  const stickerApi=(path,body)=>api(path,{...body,stickerScope:boundStickerScope})
  window.StickerUploadUI?.bind({api:stickerApi,toast,onSaved:load})
  document.querySelectorAll('[data-stk-save]').forEach(el => el.onclick = async () => {
    const id = el.dataset.stkSave
    const name = document.querySelector('[data-stk-name="' + id + '"]').value
    const keywords = document.querySelector('[data-stk-kw="' + id + '"]').value
    const scenes = Array.from(document.querySelectorAll('[data-scene-item="' + id + '"]:checked')).map(function(x){ return x.value })
    const description=document.querySelector('[data-stk-desc="'+id+'"]').value
    const file=document.querySelector('[data-stk-file="'+id+'"]').files[0]
    el.disabled=true
    try {
      const dataUrl=file?await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('图片读取失败'));r.readAsDataURL(file)}):undefined
      await stickerApi('/api/action/sticker-update', { id, name, keywords, scenes, description, dataUrl }); toast('已保存'); await load() }
    catch (e) { toast('保存失败：' + e.message, true) }
    finally{el.disabled=false}
  })
  document.querySelectorAll('[data-stk-del]').forEach(el => el.onclick = async () => {
    if (!await ask('仅删除这张表情包？', '图片文件也会一起删掉，但以后仍可能重新学习。不想再收录请选择“拉入黑名单并删除”。', '仅删除')) return
    try { await stickerApi('/api/action/sticker-delete', { id: el.dataset.stkDel }); await load(); toast('已删除') }
    catch (e) { toast('删除失败：' + e.message, true) }
  })
  document.querySelectorAll('[data-stk-block]').forEach(el=>el.onclick=async()=>{
    if(!await ask('拉入黑名单并删除？','会从可用库移除，保留图片供黑名单预览。以后自动学习和上传都不会再次收录；可在黑名单中解除。','拉入黑名单'))return
    el.disabled=true
    try{await stickerApi('/api/action/sticker-blacklist',{id:el.dataset.stkBlock});await load();toast('已加入黑名单并删除')}
    catch(e){toast('操作失败：'+e.message,true)}finally{el.disabled=false}
  })
  document.querySelectorAll('[data-stk-unblock]').forEach(el=>el.onclick=async()=>{
    el.disabled=true
    try{await stickerApi('/api/action/sticker-unblock',{hash:el.dataset.stkUnblock});await load();toast('已解除，允许再次学习或上传')}
    catch(e){toast('解除失败：'+e.message,true)}finally{el.disabled=false}
  })
  const stkSend = document.getElementById('stkSend')
  if (stkSend) stkSend.onclick = async () => {
    const groupId = document.getElementById('stkSendGroup').value
    const keyword = document.getElementById('stkSendKw').value.trim()
    try { const r = await stickerApi('/api/action/sticker-send', { groupId, keyword, text:document.getElementById('stkSendText').value.trim() }); toast('已发送「' + r.name + '」') }
    catch (e) { toast('发送失败：' + e.message, true) }
  }
  // 记忆浏览：查看 / 单条改删 / 摘要编辑 / 清空
  const reloadMemoryDetail = async (key) => {
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { memoryDetail = await api('/api/memory-detail?key=' + encodeURIComponent(key)); lastErr = null; break }
      catch (err) { lastErr = err; await new Promise(function(resolve){ setTimeout(resolve, 300) }) }
    }
    if (lastErr) throw lastErr
    render()
  }
  document.querySelectorAll('[data-memfold]').forEach(el => el.onclick = () => {
    const type = el.dataset.memfold
    const opening = memoryFold[type] === false
    if (opening) {
      // 手风琴：同一时间只展开一个目录
      memoryFold = { group: false, private: false }
      memoryFold[type] = true
    } else {
      memoryFold[type] = false
    }
    // 详情只能存在于展开着的目录里；目录一收或换组，就自动收回
    if (memoryDetail) {
      const isGroup = String(memoryDetail.key).startsWith('g')
      if (!memoryFold[isGroup ? 'group' : 'private']) memoryDetail = null
    }
    render()
  })
  document.querySelectorAll('[data-memview]').forEach(el => el.onclick = async () => {
    const key = el.dataset.memview
    if (memoryDetail && memoryDetail.key === key) {
      memoryDetail = null
      render()
      return
    }
    memoryFold = { group: false, private: false }
    memoryFold[String(key).startsWith('g') ? 'group' : 'private'] = true
    try { await reloadMemoryDetail(key) }
    catch (e) { toast('读取失败：' + e.message, true) }
  })
  document.querySelectorAll('[data-mem-edit]').forEach(el => el.onclick = async () => {
    const idx = Number(el.dataset.memEdit)
    const item = memoryDetail?.recent?.[idx]
    if (!item) { toast('这条记忆已经变化，请刷新', true); return }
    const text = await ask('修改这条记忆', '保存后立刻写回；机器人之后的回复会用改后的内容。', '保存', true, item.content)
    if (text === null || text === undefined) return
    try {
      await api('/api/action/memory-update', { key: memoryDetail.key, index: idx + (memoryDetail.recentOffset || 0), revision: memoryDetail.revision, content: text })
      await reloadMemoryDetail(memoryDetail.key)
      toast('已修改')
    } catch (e) { toast('修改失败：' + e.message, true) }
  })
  document.querySelectorAll('[data-mem-del]').forEach(el => el.onclick = async () => {
    const idx = Number(el.dataset.memDel)
    const item = memoryDetail?.recent?.[idx]
    if (!item) { toast('这条记忆已经变化，请刷新', true); return }
    if (!await ask('删除这条记忆？', String(item.content).slice(0, 80) + '…', '删除')) return
    try {
      await api('/api/action/memory-delete', { key: memoryDetail.key, index: idx + (memoryDetail.recentOffset || 0), revision: memoryDetail.revision })
      await reloadMemoryDetail(memoryDetail.key)
      toast('已删除这一条')
    } catch (e) { toast('删除失败：' + e.message, true) }
  })
  document.querySelectorAll('[data-pending-del]').forEach(el => el.onclick = async () => {
    const idx = Number(el.dataset.pendingDel)
    if (!await ask('丢弃这条待整理原文？', '丢了就不会再进长期记忆。', '丢弃')) return
    try {
      await api('/api/action/pending-delete', { key: memoryDetail.key, index: idx, revision: memoryDetail.pendingRevision })
      await reloadMemoryDetail(memoryDetail.key)
      toast('已丢弃')
    } catch (e) { toast('删除失败：' + e.message, true) }
  })
  const lmPause = document.getElementById('lmPause')
  if (lmPause) lmPause.onclick = async () => {
    try {
      if (memoryDetail.paused && !await ask('恢复自动整理？', '请先保存编辑内容。恢复后，新整理会基于已保存摘要合并原文。', '恢复')) return
      await api('/api/action/' + (memoryDetail.paused ? 'longmemory-resume' : 'longmemory-pause'), { key: memoryDetail.key })
      await reloadMemoryDetail(memoryDetail.key)
    } catch(e) { toast(e.message, true) }
  }
  const lmSave = document.getElementById('lmSave')
  if (lmSave) lmSave.onclick = async () => {
    const box = document.getElementById('lmEdit')
    const hint = document.getElementById('lmHint')
    lmSave.disabled = true
    try {
      const r = await api('/api/action/longmemory-update', { key: memoryDetail.key, text: box.value })
      if (hint) hint.textContent = '已保存 ' + r.chars + ' 字'
      toast('长期记忆已保存，自动整理保持暂停')
      await load()
    } catch (e) { toast('保存失败：' + e.message, true) }
    lmSave.disabled = false
  }
  document.querySelectorAll('[data-memclear]').forEach(el => el.onclick = async () => {
    const key = el.dataset.memclear
    if (!await ask('清空「' + key + '」的全部记忆？', '会一次性清掉近期、长期和待整理；如果只想删几条，用上面每条的「改 / 删」。', '清空')) return
    try {
      const r = await api('/api/action/clear-memory', { key })
      memoryDetail = null
      await load()
      toast('已清空：近期 ' + (r.recent || 0) + ' 条' + (r.longTerm ? '、长期 1 份' : ''))
    } catch (e) { toast('清空失败：' + e.message, true) }
  })
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => {
    try { await api('/api/action/reset-chat', { key: b.dataset.reset }); toast('已恢复默认'); await load() }
    catch(e){ toast(e.message, true) }
  })
  document.querySelectorAll('[data-mem]').forEach(b => b.onclick = async () => {
    const r = await api('/api/memory?key=' + encodeURIComponent(b.dataset.mem))
    showMemory('「' + b.dataset.mem + '」最近 ' + r.items.length + ' 条记忆', r.items)
  })
  document.querySelectorAll('[data-say]').forEach(b => b.onclick = async () => {
    const text = await ask('发送消息', '会以机器人身份直接发到 ' + b.dataset.say + '。', '发送', true)
    if (!text) return
    try { await api('/api/action/say', { key: b.dataset.say, text }); toast('已发送') } catch(e){ toast(e.message, true) }
  })
  // 添加会话：从联系人/群列表里选，不用手打号码
  const newchatType = document.getElementById('newchatType')
  const newchatPick = document.getElementById('newchatPick')
  const newchatInput = document.getElementById('newchat')
  const fillChatPick = function(){
    if (!newchatPick) return
    const type = newchatType ? newchatType.value : 'g'
    const items = type === 'p' ? (friendList || []) : (joinedGroups || [])
    newchatPick.innerHTML = '<option value="">' + (type === 'p' ? '从好友里选…' : '从群列表里选…') + '</option>' +
      items.map(function(x){ return '<option value="' + esc(x.id) + '">' + esc(x.name) + '（' + esc(x.id) + '）</option>' }).join('')
  }
  if (newchatType) {
    newchatType.onchange = function(){ fillChatPick(); if (newchatInput) newchatInput.value = '' }
    fillChatPick()
  }
  if (newchatPick && newchatInput) {
    newchatPick.onchange = function(){ if (newchatPick.value) newchatInput.value = newchatPick.value }
  }
  const add = document.getElementById('addchat')
  if (add) add.onclick = async () => {
    const v = document.getElementById('newchat').value.trim()
    if (!/^\d{5,12}$/.test(v)) { toast('请输入 5～12 位数字 ID', true); return }
    const type = document.getElementById('newchatType').value
    const key = type + v
    try {
      if (type === 'w') {
        await api('/api/action/update-whitelist', { operation: 'add', groupIds: [Number(v)] })
        await api('/api/action/set-chat', { key: 'g' + v, patch: {} })
        toast('已加入白名单群，可主动搭话')
      } else if (type === 'p') {
        await api('/api/action/set-chat', { key: 'p' + v, patch: {} })
        const current = (state && state.config && state.config.privateWhitelist) || []
        if (!current.map(String).includes(String(v))) {
          await api('/api/action/set-config', { key: 'PRIVATE_WHITELIST', value: current.concat([v]).join(',') })
        }
        toast('已添加私聊并加入白名单')
      } else {
        await api('/api/action/set-chat', { key: 'g' + v, patch: {} })
        toast('已添加群会话，可展开设置')
      }
      openChats.add(key); await load()
    } catch(e){ toast('添加失败：' + e.message, true) }
  }
  const search = document.getElementById('chatSearch')
  if (search) search.oninput = () => {
    const q = search.value.trim().toLowerCase()
    document.querySelectorAll('.chat').forEach(box => { box.style.display = box.textContent.toLowerCase().includes(q) ? '' : 'none' })
  }
  const importButton = document.getElementById('importWhitelist')
  if (importButton) importButton.onclick = importWhitelist
  document.querySelectorAll('[data-open-chat]').forEach(b => b.onclick = () => {
    openChats.add(b.dataset.openChat)
    const box = document.querySelector(`.chat[data-key="${b.dataset.openChat}"]`)
    if (box) { box.classList.add('open'); box.scrollIntoView({behavior:'smooth', block:'start'}) }
  })
  document.querySelectorAll('[data-delchat]').forEach(b => b.onclick = async (ev) => {
    ev.stopPropagation()
    const key = b.dataset.delchat
    const isPrivate = String(key).startsWith('p')
    if (!await ask('删除这个会话？', isPrivate ? '会删除它的记忆和会话设置，并移出私聊白名单（之后不再回复）。记忆有备份。' : '会删除它的记忆和会话设置，并移出白名单。记忆有备份。', '删除')) return
    try {
      await api('/api/action/delete-chat', { key })
      openChats.delete(key)
      await load()
      toast('已删除会话')
    } catch(e) { toast('删除失败：' + e.message, true) }
  })
  document.querySelectorAll('[data-whitelist]').forEach(b => b.onclick = async () => {
    const id = b.dataset.group, operation = b.dataset.whitelist
    if (operation === 'remove' && !await ask('移出白名单？', `「${groupName(id)}」（${id}）将停止主动搭话。聊天记录和单独设置保留；被 @ 回复及定时任务不变。`, '移出白名单')) return
    b.disabled = true
    try { await api('/api/action/update-whitelist', {operation, groupIds:[id]}); await load(); toast(operation === 'remove' ? '已移出白名单，停止主动搭话' : '已加入白名单，即时生效') }
    catch(e){ b.disabled = false; toast(e.message, true) }
  })

  // 人格
  const sel = document.getElementById('personaSel')
  if (sel) {
    const loadOne = async (name) => {
      if (personaCache[name] !== undefined) return personaCache[name]
      const r = await api('/api/action/get-persona', { name }).catch(() => ({ content: '' }))
      personaCache[name] = r.content ?? ''
      return personaCache[name]
    }
    document.getElementById('personaText').value = await loadOne(sel.value)
    sel.addEventListener('change', async () => { selectedPersona = sel.value; document.getElementById('personaText').value = await loadOne(sel.value) })
  }
  const exportActive = document.getElementById('exportActivePersona')
  if (exportActive) exportActive.onclick = async () => {
    try { const p = await api('/api/action/export-persona-package', {}); downloadPersonaFile(p.filename, p.content); toast('已导出当前使用的人格') }
    catch(e){ toast(e.message, true) }
  }
  const greetingEditor=document.getElementById('editGreetingLibrary')
  if(greetingEditor)greetingEditor.onclick=async()=>{
    const content=document.getElementById('personaText').value
    if(!content.trim())return toast('请先填写人格正文',true)
    try{
      const result=await api('/api/action/get-greeting-library',{content}),lib=result.library||{}
      const root=document.getElementById('modalRoot')
      root.innerHTML=`<div class="modal wide" role="dialog" aria-modal="true"><h2>此人格的早晚安语库</h2><p>每段用空行分隔，每种最多24段，每段最多240字。定时随机发送，不调用AI；多段时避免连续选中同一句。正文改动后需为新版本设置语库。</p><h3>早安</h3><textarea id="morningPhrases" style="min-height:130px"></textarea><h3>晚安</h3><textarea id="nightPhrases" style="min-height:130px"></textarea><div class="row"><button class="btn" id="closePhrases">取消</button><button class="btn primary" id="savePhrases">保存语库</button></div></div>`
      root.querySelector('#morningPhrases').value=(lib.goodmorning||[]).join('\n\n')
      root.querySelector('#nightPhrases').value=(lib.goodnight||[]).join('\n\n')
      root.classList.add('show');root.setAttribute('aria-hidden','false')
      const close=()=>{root.classList.remove('show');root.setAttribute('aria-hidden','true');root.innerHTML=''}
      root.querySelector('#closePhrases').onclick=close
      root.querySelector('#savePhrases').onclick=async()=>{
        const button=root.querySelector('#savePhrases');button.disabled=true
        const lines=id=>root.querySelector(id).value.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean)
        try{await api('/api/action/save-greeting-library',{content,library:{goodmorning:lines('#morningPhrases'),goodnight:lines('#nightPhrases')}});close();toast('语库已保存，只供此人格版本使用')}
        catch(e){button.disabled=false;toast(e.message,true)}
      }
    }catch(e){toast(e.message,true)}
  }
  const morningCatchup=document.getElementById('catchUpMorning')
  if(morningCatchup)morningCatchup.onclick=async()=>{
    morningCatchup.disabled=true
    try{const result=await api('/api/action/send-morning-greetings',{});toast(`已补发 ${result.sent} 群早安${result.uncertain?'；部分发送结果待核实':''}；已发、寂静时段内或语库缺失的群跳过`)}catch(e){toast(e.message,true)}finally{morningCatchup.disabled=false}
  }
  const exportEdited = document.getElementById('exportEditedPersona')
  if (exportEdited) exportEdited.onclick = () => {
    const name = document.getElementById('personaSel').value || '编辑中人格'
    downloadPersonaFile('Koukou-' + name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') + '-人格.txt', document.getElementById('personaText').value)
    toast('已导出编辑框内容')
  }
  const personaImportButton = document.getElementById('importPersonaBtn'), personaImportFile = document.getElementById('importPersonaFile')
  if (personaImportButton && personaImportFile) {
    personaImportButton.onclick = () => personaImportFile.click()
    personaImportFile.onchange = async () => {
      const file = personaImportFile.files?.[0]; personaImportFile.value = ''; if (!file) return
      try {
        if(/\.json$/i.test(file.name)){
          if(file.size>1200000)throw Error('人格包过大')
          const pkg=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()).replace(/^\uFEFF/,''))
          if(pkg.format!=='koukou-persona'||pkg.version!==1||typeof pkg.content!=='string')throw Error('不是支持的人格包')
          previewPersonaImport(file,pkg.content,pkg.greetings)
        }else previewPersonaImport(file, await readPersonaFile(file))
      }
      catch(e){ toast(e.message, true) }
    }
  }
  const sp = document.getElementById('savePersona')
  if (sp) sp.onclick = async () => {
    const name = document.getElementById('personaSel').value
    try { const r = await api('/api/action/save-persona', { name, content: document.getElementById('personaText').value }); personaCache[name] = document.getElementById('personaText').value; toast(r.applied ? '人格已保存并立即生效' : '人格已保存；点击“切换使用”应用此版本') }
    catch(e){ toast(e.message, true) }
  }
  const act = document.getElementById('activate')
  if (act) act.onclick = async () => {
    const name = document.getElementById('personaSel').value
    act.disabled = true
    try { const r = await api('/api/action/activate-persona', { name }); toast(r.changed ? '已全局切换到「' + name + '」，旧会话记忆已备份并重置' : '当前已经使用此人格，记忆未清空'); await load() }
    catch(e){ toast(e.message, true) }
    finally { act.disabled = false }
  }
  const cr = document.getElementById('createPersona')
  if (cr) cr.onclick = async () => {
    const name = document.getElementById('newPersona').value.trim()
    if (!name) return
    try { await api('/api/action/create-persona', { name, content: '你是群里的普通群友，说话口语化、简短自然。\n\n说话要求：\n- 通常一两句话，别长篇大论\n- 不用客服腔、不分点列举\n' }); toast('已新建'); await load() }
    catch(e){ toast(e.message, true) }
  }
  const dp = document.getElementById('delPersona')
  if (dp) dp.onclick = async () => {
    const name = document.getElementById('personaSel').value
    if (!await ask('删除人格？', '「' + name + '」将从人格列表和配置文件中删除。', '删除')) return
    try { await api('/api/action/delete-persona', { name }); toast('已删除'); await load() } catch(e){ toast(e.message, true) }
  }

  // 配置
  document.querySelectorAll('[data-reveal]').forEach(btn => btn.onclick = () => {
    const input = document.querySelector('[data-cfg="' + btn.dataset.reveal + '"]')
    if (!input) return
    input.type = input.type === 'password' ? 'text' : 'password'
    btn.textContent = input.type === 'password' ? '显示输入' : '隐藏输入'
  })
  const cfgValue = (el) => el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value
  const cfgEls = [...document.querySelectorAll('[data-cfg]')]
  cfgEls.forEach(el => { el.dataset.original = cfgValue(el) })
  const updateDirty = () => {
    const count = cfgEls.filter(el => cfgValue(el) !== el.dataset.original && !(el.dataset.secret && !el.value)).length
    const save = document.getElementById('saveCfg')
    const invalidRate = [...document.querySelectorAll('[data-rate-percent]')].some(el => !el.value.trim() || !el.checkValidity())
    if (save) { save.disabled = !count || invalidRate; save.textContent = invalidRate ? '请修正群概率' : count ? '保存 ' + count + ' 项改动' : '没有待保存的改动' }
    const hint = document.getElementById('cfgDirty')
    if (hint && count) hint.textContent = '仅保存已修改的项目'
  }
  document.querySelectorAll('[data-cfg]').forEach(el => {
    if (el.type === 'range') el.oninput = () => {
      const s = document.querySelector('[data-cfgshow="' + el.dataset.cfg + '"]')
      if (s) s.textContent = (el.value*100).toFixed(0) + '%'
    }
    el.addEventListener('input', updateDirty)
    el.addEventListener('change', updateDirty)
  })
  const rateEditor = document.querySelector('.rate-editor')
  if (rateEditor) {
    const rows = document.getElementById('groupRateRows'), source = rateEditor.querySelector('[data-cfg]')
    const syncRates = () => {
      const invalid = [...rows.querySelectorAll('[data-rate-percent]')].some(el => !el.value.trim() || !el.checkValidity())
      document.getElementById('rateEmpty').hidden = !!rows.children.length
      document.getElementById('rateError').textContent = invalid ? '概率请填写 0～100 之间的数字，例如 20 表示 20%。' : ''
      if (!invalid) source.value = [...rows.children].map(row => `${row.dataset.rateGroup}:${Number((Number(row.querySelector('[data-rate-percent]').value)/100).toFixed(10))}`).join(',')
      updateDirty()
    }
    rows.oninput = syncRates
    rows.onclick = ev => {
      const button = ev.target.closest('[data-remove-rate]')
      if (button) { button.closest('[data-rate-group]').remove(); syncRates() }
    }
    const picker = document.getElementById('rateGroupPick'), manual = document.getElementById('rateGroupId')
    picker.onchange = () => { manual.hidden = picker.value !== 'manual'; if (!manual.hidden) manual.focus() }
    document.getElementById('addGroupRate').onclick = () => {
      const raw = picker.value === 'manual' ? manual.value.trim() : picker.value
      if (!/^\d{5,12}$/.test(raw)) { toast('请选择群聊或输入 5～12 位群号', true); return }
      const id = Number(raw), existing = rows.querySelector(`[data-rate-group="${id}"]`)
      if (existing) { existing.querySelector('input').focus(); toast('这个群已经在列表中，可直接调整概率'); return }
      rows.insertAdjacentHTML('beforeend', rateRow(id, Number(state?.config?.proactiveRate || 0)))
      rows.lastElementChild.querySelector('input').focus()
      picker.value = ''; manual.value = ''; manual.hidden = true; syncRates()
    }
  }
  const sc = document.getElementById('saveCfg')
  if (sc) sc.onclick = async () => {
    for (const input of document.querySelectorAll('[data-rate-percent]')) {
      if (!input.value.trim() || !input.reportValidity()) { toast('群概率请填写 0～100 之间的数字', true); return }
    }
    const patch = {}
    cfgEls.forEach(el => {
      if (cfgValue(el) !== el.dataset.original && !(el.dataset.secret && !el.value)) patch[el.dataset.cfg] = cfgValue(el)
    })
    if (!Object.keys(patch).length) return
    sc.disabled = true
    try {
      const r = await api('/api/action/set-config-batch', { patch })
      toast(`已保存 ${r.changed} 项（即时生效 ${r.live} 项）${r.needRestart ? '，其余项目重启后生效' : ''}`)
      await load()
    } catch(e){ toast('保存失败：' + e.message, true); sc.disabled = false }
  }

  // 日志
  const lf = document.getElementById('logFilter')
  if (lf) lf.onchange = () => { logFilter = lf.value; refreshLogs() }
  const la = document.getElementById('logAuto')
  if (la) la.onchange = () => { logAuto = la.checked }
  const ll = document.getElementById('logLines')
  if (ll) ll.onchange = () => refreshLogs()

  // 数据
  const lm = document.getElementById('loadMem')
  if (lm) lm.onclick = async () => {
    const key = document.getElementById('memKey').value
    const r = await api('/api/memory?key=' + encodeURIComponent(key))
    showMemory(key + ' 最近 ' + r.items.length + ' 条', r.items)
  }
  const llm = document.getElementById('loadLm')
  if (llm) llm.onclick = async () => {
    const key = document.getElementById('lmKey').value
    const r = await api('/api/longmemory?key=' + encodeURIComponent(key) + '&q=' + encodeURIComponent(document.getElementById('lmQuery').value))
    document.getElementById('lmBox').textContent = r.text || '（这个会话还没有长期记忆摘要）'
  }
  const ds = document.getElementById('doSummary')
  if (ds) ds.onclick = doSummary
}
function showMemory(title, items){
  const html = items.map(m => `<div style="margin-bottom:7px"><span class="badge">${m.role === 'assistant' ? '机器人' : '群友'}</span> ${esc(m.content)}</div>`).join('')
  const box = document.getElementById('memBox')
  if (box) box.innerHTML = '<div class="mut" style="margin-bottom:8px">' + esc(title) + '</div>' + (html || '<div class="empty">空</div>')
  else { const d = document.createElement('div'); d.className='card mono'; d.innerHTML = '<b>'+esc(title)+'</b><br>'+html; document.getElementById('main').appendChild(d) }
}
async function doSummary(){
  const groupId = document.getElementById('sumGroup') ? document.getElementById('sumGroup').value : null
  const days = Number(document.getElementById('sumDays')?.value || 1)
  if (!await ask('生成并发送群聊报告？', '目标：' + (groupId ? '群 ' + groupId : '配置中的所有目标群') + '，范围：近 ' + days + ' 天。生成完成后会直接发送。', '开始生成')) return
  try { const r = await api('/api/action/summary', { groupId, days }); state.summaryProgress=r.progress||state.summaryProgress; refreshSummaryControls(); toast('已启动（群 ' + (r.groups||[]).join(',') + '），可在会话管理查看进度；消息多时可能需要较长时间') }
  catch(e){ toast(e.message, true) }
}
async function refreshLogs(){
  try {
    const lines = document.getElementById('logLines')?.value || 200
    const r = await api('/api/logs?lines=' + lines + '&filter=' + encodeURIComponent(logFilter))
    const bot = document.getElementById('logBot')
    if (bot) { bot.innerHTML = r.bot.map(l => '<div class="l">' + esc(l) + '</div>').join('') || '<div class="empty">暂无日志</div>'; bot.scrollTop = bot.scrollHeight }
  } catch(e){ /* 静默 */ }
}
async function loadDaily(){
  try {
    const r = await api('/api/daily')
    const html = r.items.length
      ? '<table><tr><th>群</th><th>日期</th><th>大小</th></tr>' + r.items.map(i => `<tr><td>${esc((chats.find(c=>String(c.id)===String(i.groupId))||{}).name || i.groupId)}</td><td>${i.date}</td><td>${(i.size/1024).toFixed(1)} KB</td></tr>`).join('') + '</table>'
      : '<div class="empty">暂无日报数据文件</div>'
    const a = document.getElementById('dailyList'); if (a) a.innerHTML = html
    const b = document.getElementById('dailyFiles'); if (b) b.innerHTML = html
  } catch(e){ /* 静默 */ }
}

// ── 数据加载 ───────────────────────────────────────────
let personaCache = {}
let appendixText = ''
async function load(){
  try {
    const [s, c, p, cfg, groups, friends, cc, models, stk] = await Promise.all([api('/api/state'), api('/api/chats'), api('/api/personas'), api('/api/config'), api('/api/groups').catch(() => ({items:[]})), api('/api/friends').catch(() => ({items:[]})), api('/api/custom-commands').catch(()=>({items:[]})), api('/api/models').catch(()=>({})), api('/api/stickers').catch(()=>({items:[]}))])
    state = s; chats = c.items; personas = p.items; activePersona = p.active; configItems = cfg.items
    joinedGroups = groups.items || []
    friendList = friends.items || []
    customCommands = cc.items || []
    commandBuiltins = cc.builtinItems || []
    pokeDiagnostics = cc.poke || {}
    modelsInfo = models || {}
    if ((stk.persona?.token || '') !== (stickerPersona?.token || '')){document.querySelectorAll('dialog[open]').forEach(d=>d.close());toast('已切换人格图库，旧人格的未保存编辑已取消')}
    stickerPersona = stk.persona || null
    window.StickerUploadUI?.setScope(stickerPersona?.token || '')
    stickerList = stk.items || []
    stickerBlacklist = stk.blacklist || []
    stickerScenes = stk.scenes || []
    stickerLearned = stk.learned || 0
    stickerLearn = stk.learn || {}
    stickerSettings = stk.settings || {}
    webSearchInfo = await api('/api/websearch').catch(function(){ return {} })
    backupInfo = await api('/api/backups').catch(function(){ return { items: [], root: '' } })
    selfCheckInfo = await api('/api/selfcheck').catch(function(){ return null })
    errorInfo = (await api('/api/errors').catch(function(){ return { items: [] } })).items || []
    pokeReplies = (await api('/api/poke-replies').catch(function(){ return { lines: [] } })).lines || []
    await loadPythonScripts()
    tasksInfo = await api('/api/tasks').catch(function(){ return null })
    metricsInfo = (await api('/api/metrics?days=' + metricsRange).catch(function(){ return { items: [] } })).items || []
    updateSideStatus(s.bot)
    // 预取人格内容与附加说明
    for (const item of personas) {
      if (personaCache[item.name] === undefined) {
        const r = await api('/api/action/get-persona', { name: item.name }).catch(()=>({ content:'' }))
        personaCache[item.name] = r.content ?? ''
      }
    }
    if (!appendixText) {
      const r = await api('/api/action/get-appendix').catch(()=>({ text:'' }))
      appendixText = r.text ?? ''
    }
    memoryOverview = (await api('/api/memory-overview').catch(()=>({items:[]}))).items || []
    render()
  } catch(e){ updateSideStatus({ statusError:'控制台未响应' }); toast('加载失败：' + e.message + '（机器人可能在重启）', true) }
}
renderNav()
load()
refreshUpdates()
setInterval(()=>refreshUpdates(),30*60*1000)
// 支持浏览器前进/后退与直接改地址栏（#chats 这类）
window.addEventListener('hashchange', () => {
  const p = location.hash.replace('#', '')
  if (PAGES.some((x) => x[0] === p) && p !== page) {
    page = p
    renderNav()
    render()
  }
})
let refreshingState = false
async function refreshStateUI() {
  if (refreshingState) return
  refreshingState = true
  try {
    state = await api('/api/state')
    updateSideStatus(state.bot)
    if(page==='chats')refreshSummaryControls()
    if (page === 'commands') { const r=await api('/api/custom-commands'); CommandCenterUI.updateDiagnostics(r.poke) }
    if (page === 'overview') {
      // 只原位更新数字，不整页重绘：整页重绘会把输入框、展开的折叠块和滚动位置全部冲掉
      const grid = document.getElementById('kpiGrid')
      if (grid) grid.outerHTML = overviewCards()
      const tbody = document.getElementById('todayGroups')
      if (tbody) tbody.innerHTML = overviewTodayRows()
      const updated = document.getElementById('updatedAt')
      if (updated) updated.textContent = new Date().toLocaleTimeString('zh-CN',{hour12:false})
      const hero = document.getElementById('heroStatus')
      if (hero) hero.innerHTML = '<span class="dot ' + (state.bot.online === true ? 'ok' : 'bad') + '"></span> ' + accountStatusText(state.bot)
    }
  } catch(e) {
    state = { ...state, bot:{ ...state?.bot, online:false, connected:false, onebotConnected:false, qqOnline:null, statusError:'控制台未响应' } }
    updateSideStatus(state.bot)
    if (page === 'overview') render()
  } finally { refreshingState = false }
}
// 表情包页：新收录的图自动出现；有未保存的编辑时不打断，只提示一次
let refreshingStickers = false, stickerPending = false, stickerNotified = false, stickerControlsDirty=false
function stickerEditsDirty() {
  if(window.StickerUploadUI?.dirty())return true
  if(stickerControlsDirty)return true
  const byId = new Map((stickerList || []).map(function (it) { return [String(it.id), it] }))
  for (const el of document.querySelectorAll('[data-stk-name],[data-stk-kw],[data-stk-desc]')) {
    const id = el.getAttribute('data-stk-name') || el.getAttribute('data-stk-kw') || el.getAttribute('data-stk-desc')
    const it = byId.get(String(id)); if (!it) continue
    const v = String(el.value == null ? '' : el.value)
    if (el.hasAttribute('data-stk-name') && v !== String(it.name == null ? '' : it.name)) return true
    if (el.hasAttribute('data-stk-kw') && v !== (it.keywords || []).join(' ')) return true
    if (el.hasAttribute('data-stk-desc') && v !== String(it.description == null ? '' : it.description)) return true
  }
  for (const el of document.querySelectorAll('[data-stk-file]')) if (el.files && el.files.length) return true
  for (const el of document.querySelectorAll('[data-scene-item]')) {
    const it = byId.get(String(el.getAttribute('data-scene-item'))); if (!it) continue
    if (el.checked !== ((it.scenes || []).indexOf(el.value) >= 0)) return true
  }
  const file = document.getElementById('stkFile')
  if (file && file.files && file.files.length) return true
  for (const id of ['stkSearch', 'stkBlockedSearch', 'stkKw', 'stkSendText', 'stkSendKw']) {
    const el = document.getElementById(id)
    if (el && String(el.value || '').trim()) return true
  }
  return false
}
async function refreshStickersUI() {
  if (refreshingStickers) return
  refreshingStickers = true
  try {
    const stk = await api('/api/stickers')
    if(page!=='stickers'||document.hidden)return
    const personaChanged=(stk.persona?.token || '') !== (stickerPersona?.token || '')
    if(personaChanged)stickerPending=true
    if(JSON.stringify([stickerList,stickerBlacklist,stickerLearn,stickerSettings])!==JSON.stringify([stk.items||[],stk.blacklist||[],stk.learn||{},stk.settings||{}]))stickerPending=true
    if (!stickerPending) return
    const mainEl = document.getElementById('main')
    const focused = document.activeElement
    const typing = focused && mainEl && mainEl.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)
    const dialogOpen = Boolean(document.querySelector('dialog[open]'))
    if (!personaChanged && (typing || dialogOpen || stickerEditsDirty())) {
      if (!stickerNotified) { stickerNotified = true; toast('表情包库有更新，保存当前修改后按 F5 刷新') }
      return
    }
    if ((stk.persona?.token || '') !== (stickerPersona?.token || '')){document.querySelectorAll('dialog[open]').forEach(d=>d.close());toast('已切换人格图库，旧人格的未保存编辑已取消')}
    stickerPersona = stk.persona || null
    window.StickerUploadUI?.setScope(stickerPersona?.token || '')
    stickerList = stk.items || []
    stickerBlacklist = stk.blacklist || []
    stickerScenes = stk.scenes || []
    stickerLearned = stk.learned || 0
    stickerLearn = stk.learn || {}
    stickerSettings = stk.settings || {}
    const oldY = window.scrollY
    render()
    window.scrollTo(0, oldY)
    stickerPending = false
    stickerNotified = false
  } catch (e) { /* 机器人重启时静默 */ }
  finally { refreshingStickers = false }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  refreshStateUI()
  if (page === 'stickers') refreshStickersUI()
})
setInterval(() => {
  if (document.hidden) return
  refreshStateUI()
  if (page === 'stickers') refreshStickersUI()
  if (page === 'logs' && logAuto) refreshLogs()
}, 3000)
