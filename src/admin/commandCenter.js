/* 浏览器指令编辑器；草稿留在页面，轮询事件不会重绘输入框。 */
window.CommandCenterUI=(()=>{
  let dupTriggers=new Set()
  let state={},draft={},builtin=false,importContent='',preview=null,description='',generationMode='fixed'
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const checked=value=>value?' checked':''
  const options=(items,value)=>items.map(([id,label])=>`<option value="${esc(id)}"${id===value?' selected':''}>${esc(label)}</option>`).join('')
  const scopes=[['all','所有会话'],['groups','所有群聊'],['group','仅选择的群聊'],['private','仅私聊']]
  const modes=[['fixed','固定回复 · 运行时不用 AI'],['random','随机回复 · 运行时不用 AI'],['ai','AI 回复 · 每次执行调用 API']]
  const modeName=c=>c.ai==='required'?'必须使用 AI':c.ai==='none'?(c.naturalLanguage?'规则执行＋AI理解':'规则执行 · 不用 AI'):c.responseMode==='ai'?'AI 回复':'规则回复'
  const scopeName=c=>c.whitelistOnly?'仅白名单群（所有成员）':c.scope==='group'?(c.groups||[]).map(id=>state.groups?.find(g=>Number(g.id)===Number(id))?.name||id).join('、')||'尚未选择群':scopes.find(s=>s[0]===c.scope)?.[1]||'所有会话'
  const field=(label,body)=>{const id=/<(?:input|textarea|select)[^>]*\bid="([^"]+)"/.exec(body)?.[1];return `<div class="frow"><label${id?` for="${esc(id)}"`:''}>${label}</label><div>${body}</div></div>`}
  const button=(label,key,value='',primary=false)=>`<button class="btn${primary?' primary':''}" type="button" data-cc-${key}="${esc(value)}">${label}</button>`
  const catOf=c=>['send-file','send-link','music','request-sticker','request-poke'].includes(c.id)?'media':(c.management||c.groupAction?'manage':(c.ai==='none'?'rule':'ai'))
  function card(c,isBuiltin){
    const dup=!isBuiltin&&[c.trigger,...(c.aliases||[])].filter(Boolean).some(t=>dupTriggers.has(t));
    return `<article class="cc-item" data-cat="${catOf(c)}" data-search="${esc((c.name+' '+(c.trigger||'')+' '+(c.description||'')).toLowerCase())}"><div class="flexbar"><strong>${esc(c.name)}</strong><span class="pill">${c.enabled?'已启用':'已关闭'}</span>${dup?'<span class="pill" style="background:#a33;color:#fff">触发词重复</span>':''}</div><p class="mut">${esc(c.trigger||'拍一拍事件')}</p><p>${esc(modeName(c))} · ${c.adminOnly?'仅机器人管理员':'按原有授权规则'}</p><p class="mut">${esc(scopeName(c))}</p>${c.description?`<p class="mut">${esc(c.description)}</p>`:''}<div class="flexbar">${button('编辑设置',isBuiltin?'builtin':'edit',c.id)}${button(c.enabled?'关闭':'启用',isBuiltin?'toggle-builtin':'toggle',c.id)}${button('导出','export',c.id)}${isBuiltin?'':button('删除','delete',c.id)}</div></article>`}
  function form(){
    const c=draft,mode=c.responseMode||'fixed',event=c.event||'message'
    const groups=new Map((state.groups||[]).map(g=>[Number(g.id),g]))
    for(const id of c.groups||[])if(!groups.has(Number(id)))groups.set(Number(id),{id,name:'群 '+id})
    const picker=`<div class="cc-picks">${[...groups.values()].map(g=>`<label class="chk"><input type="checkbox" data-cc-group value="${esc(g.id)}"${checked((c.groups||[]).map(Number).includes(Number(g.id)))}> ${esc(g.name)} <small>(${esc(g.id)})</small></label>`).join('')||'<span class="mut">暂未取得群列表，可在下方输入群号。</span>'}</div><input id="ccExtraGroups" placeholder="其他群号，可用空格或换行分隔"><div class="mut">只有选择“仅选择的群聊”时使用此名单，至少选择一群。</div>`
    return `<details class="card" id="ccEditor"><summary><b class="api-card-title">${builtin?'内置功能设置':c.id?'编辑自定义指令':'新建自定义指令'}</b></summary><div class="api-card-body">${builtin?`<div class="note">${esc(c.description)}。这里管理触发和权限，内置功能继续使用原实现。</div>`:''}
    ${field('名称',`<input id="ccName" value="${esc(c.name||'')}"${builtin?' readonly':''} placeholder="如：早安问候">`)}
    ${!builtin?field('触发方式',`<select id="ccEvent">${options([['message','聊天消息'],['poke','拍一拍机器人']],event)}</select>`):''}
    ${field('触发词',`<input id="ccTrigger" value="${esc(c.trigger||'')}"${builtin?' readonly':''} placeholder="如 /早安；拍一拍无需填写"><div class="mut">${builtin?'使用既有指令格式。':'匹配外层消息，转发记录中的指令不会触发。'}</div>`)}
    ${!builtin?field('别名',`<input id="ccAliases" value="${esc((c.aliases||[]).join('，'))}" placeholder="多个触发词，用逗号分隔">`)+field('匹配方式',`<select id="ccMatch">${options([['exact','整句匹配'],['prefix','开头匹配，可带参数'],['contains','包含触发词']],c.match||'exact')}</select>`):''}
    ${!builtin||c.ai==='optional'?field('执行方式',`<select id="ccMode">${options(builtin?[['fixed','原有随机语料 · 不用 AI'],['ai','AI 拍一拍回复 · 调用 API']]:modes,mode)}</select>`):field('AI API',`<div class="note">${c.whitelistOnly?'任何成员在白名单群@机器人请求拍指定成员。支持@、昵称、引用和近期上下文；不明确时只接本人下一条补充；QQ实际成功后才生成一句回复。':c.groupAction?'AI 理解当前撤回请求，程序核对原消息作者、群范围及群权限后调用 QQ 原生接口。缺少引用时只接受本人下一条补充，不自动选择上一条消息。':c.management?'AI 理解当前 @ 请求，支持明确的引用和近期上下文选人、最多20人批量，以及数学时长。程序核对权限和参数后执行；未选群不进入解析。全员禁言另有开关，原生时段禁言暂不支持。':c.ai==='required'?'该功能生成正文必须使用 AI；若不需要，请关闭整条指令。':c.semantic?'执行本身不用 AI。可选的自然语言理解会单独调用 API。':'执行不调用 AI，保留原有精确触发与授权规则。'}</div>`)}
    ${!builtin||c.ai==='optional'?field(mode==='ai'?'AI 执行要求':'回复内容',builtin&&mode!=='ai'?'<div class="note">继续使用当前实例已有拍一拍语料，不会被默认示例覆盖。</div>':`<textarea id="ccBody" rows="5" placeholder="${mode==='ai'?'描述每次触发时 AI 应该做什么':'固定回复可换行；随机回复每行一个候选'}">${esc(mode==='ai'?c.aiPrompt||'':c.reply||'')}</textarea><div class="mut">${mode==='ai'?'仅触发这条指令时生成回复。':'可用 {name} 昵称、{qq}、{time}、{date}、{args} 参数；不会调用模型。'}</div>`):''}
    ${(!builtin&&mode==='ai')||c.semantic?field('自然语言触发',`<label class="chk"><input id="ccNatural" type="checkbox"${checked(c.naturalLanguage)}> 允许直接对机器人描述意图，不必记住触发词</label><div class="mut">只处理私聊、@ 或引用机器人的当前消息。识别意图也会调用 API；默认关闭。</div>`)+field('意图说明',`<textarea id="ccDescription" rows="2"${builtin?' readonly':''} placeholder="例如：群友希望得到一句简短的鼓励">${esc(c.description||'')}</textarea>`):''}
    ${c.whitelistOnly?field('适用范围','<div class="note">固定为白名单群；所有成员均可请求，私聊与非白名单群不执行。</div>'):field('适用范围',`<select id="ccScope">${options(c.management||c.groupAction?scopes.filter(([id])=>id==='group'):scopes,c.scope||'all')}</select>`)}
    <div id="ccGroupsBox"${c.scope==='group'?'':' hidden'}>${field('选择群聊',picker)}</div>
    ${field('权限',`<label class="chk"><input id="ccAdmin" type="checkbox"${checked(c.adminOnly)}${c.protected||c.groupAction?' disabled':''}> 额外要求机器人管理员</label><div class="mut">${c.groupAction?(c.id==='self-recall'?'普通成员只能撤回自己的消息；群主或同时担任本群管理员的控制台管理员可引用撤回他人消息。机器人须有管理权限；无引用时只接本人两分钟内的下一条补充。失败不自动重试。':'白名单群里任何成员可请求拍指定成员；支持昵称、引用和近期上下文。实际成功后才生成一句回复，不触发原有被拍回应。'):c.management?(c.id==='whole-mute'?'要求当前群主，或控制台管理员且同时担任本群管理员，明确开启或关闭全员禁言；此处仅控制指令是否启用，不操作 QQ 开关，不设置发言频率。':(c.id==='owner-mute'?'要求当前群主，或控制台管理员且同时担任本群管理员；目标为明确的普通成员，可以批量，重名或含糊指代先询问。':'始终只能由成员本人申请禁言自己，不能用上下文替别人申请。')+'默认一分钟，最高30天；不足一分钟说明限制且不执行，超限不截短，数学结果按秒向上取整。'):'机器人管理员在工作台配置；留空不视为管理员。名片核对与移出成员仍遵守原有操作员及群权限条件。'}</div>`)}
    ${!builtin?field('冷却时间',`<input id="ccCooldown" type="number" min="0" max="86400" value="${Number(c.cooldownSec)||0}"><small>秒；同一会话两次执行的最短间隔。</small>`):''}
    ${!builtin?`<details><summary>每日定时推送（仅文字触发的固定回复）</summary>${field('开关',`<label class="chk"><input id="ccSchedule" type="checkbox"${checked(c.scheduleEnabled)}> 每日到点推送</label>`)}${field('时间',`<input id="ccTimes" value="${esc((c.scheduleTimes||[]).join(','))}" placeholder="09:00,21:30">`)}${field('目标群',`<input id="ccScheduleGroups" value="${esc((c.scheduleGroups||[]).join(' '))}" placeholder="群号，空格分隔"><small>同时遵守本指令适用范围；管理员限制只针对用户触发。</small>`)}</details>`:''}
    ${field('启用',`<label class="chk"><input id="ccEnabled" type="checkbox"${checked(c.enabled!==false)}> 保存后启用这条指令</label>`)}
    <div class="flexbar"><button class="btn primary" id="ccSave">保存设置</button><button class="btn" id="ccNew">新建一条</button><span class="mut">生成草稿和预览导入均不会自动启用。</span></div></div></details>`
  }
  function render(data){state=data;dupTriggers=(()=>{const seen=new Set(),dup=new Set();for(const c of data.custom||[]){for(const t of [c.trigger,...(c.aliases||[])].filter(Boolean)){if(seen.has(t))dup.add(t);else seen.add(t)}}return dup})();return `<style>.cc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px}.cc-item{padding:18px;border:1px solid var(--border,#31465c);border-radius:18px;overflow-wrap:anywhere}.cc-item p{font-size:13px;margin:9px 0}.cc-item .btn{padding:7px 10px;font-size:12px}.cc-picks{display:grid;gap:9px;max-height:240px;overflow:auto;margin-bottom:12px}.cc-picks small{opacity:.6}.cc-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center}#ccEditor{scroll-margin-top:20px}</style>
    <h1>指令中心</h1><div class="sub">已有功能与自定义规则统一管理。规则可以不用 AI；也可以只在创建时让 AI 帮忙。</div>
    <section class="card"><div class="cc-tools"><strong>${data.builtins.length} 项已有功能 · ${data.custom.length} 条自定义指令</strong><button class="btn primary" id="ccCreate">新建指令</button><button class="btn" data-cc-export="">导出全部</button><label class="chk"><input type="checkbox" id="ccExportGroups"> 导出时包含群号</label></div><p class="mut">默认导出不包含群号、凭据或聊天记忆。内置指令导出的是设置，不是功能源代码。</p></section>
    <details class="card"><summary><strong>已有功能</strong></summary><div class="flexbar" style="margin:12px 0"><input id="ccSearch" placeholder="搜索名称、触发词或说明" style="flex:1;min-width:200px"><select id="ccCat"><option value="all">全部</option><option value="media">媒体 / 发送</option><option value="manage">群管理</option><option value="ai">AI 互动</option><option value="rule">规则回复</option></select></div><div class="cc-grid" id="ccBuiltinGrid" style="margin-top:16px">${data.builtins.map(c=>card(c,true)).join('')}</div><p class="mut">其他机器人的 /今日猪猪 等指令仍由原机器人执行，已有定时调用在“群聊报告 / 定时指令”中管理。</p></details>
    <section class="card"><h2>拍一拍检测</h2><div id="ccPokeStatus">${diagnosticText(data.poke)}</div><button class="btn" id="ccPokeCheck">开始观察拍一拍</button><div class="mut">请在 QQ 拍机器人头像；这里只观察真实事件，不向群里发送测试消息。关闭回应后仍可检测事件。</div></section>
    <details class="card"><summary><b class="api-card-title">自定义指令</b> <span class="api-card-meta">${data.custom.length} 条</span></summary><div class="api-card-body">${data.custom.length?`<div class="cc-grid">${data.custom.map(c=>card(c,false)).join('')}</div>`:'<p class="mut">还没有自定义规则。已有功能在上方，不需要重新添加。</p>'}</div></details></section>
    <section class="card"><h2>用自然语言生成草稿</h2><p class="mut">这一步使用“模型与接口”中的对话模型调用一次 AI。选固定或随机回复，保存后运行不再调用 AI；复杂功能仍使用已有实现。</p><textarea id="ccGenerateDescription" rows="3" placeholder="例如：群友说早安时，从三句简短问候中随机回复一句，带上昵称。">${esc(description)}</textarea><div class="flexbar"><select id="ccGenerateMode">${options(modes,generationMode)}</select><button class="btn" id="ccGenerate">调用 AI 生成草稿</button><span id="ccGenerateStatus" class="mut"></span></div></section>
    ${form()}
    <section class="card"><h2>导入指令文件</h2><p class="mut">先预览，再确认导入。追加保存，不覆盖已有自定义指令；新导入规则、自然语言触发和定时推送默认关闭。</p><input type="file" id="ccImportFile" accept=".json,application/json"><div id="ccImportPreview">${preview?`<p>${preview.commands.length} 条自定义规则：${preview.commands.map(c=>esc(c.name)).join('、')||'无'}</p><p>${preview.builtins.length} 项内置功能设置：${preview.builtins.map(c=>esc(c.id)).join('、')||'无'}</p><label class="chk"><input type="checkbox" id="ccImportBuiltins"> 同时覆盖文件中的内置功能设置（导入后关闭，需手动检查启用）</label><div class="flexbar"><button class="btn primary" id="ccImportCommit">确认导入</button><button class="btn" id="ccImportCancel">取消</button></div>`:''}</div></section>`}
  function diagnosticText(p={}){return p.lastAt?`已收到 ${Number(p.count)||0} 次事件；最近一次 ${esc(new Date(p.lastAt).toLocaleString())} · ${p.lastGroupId?'群 '+esc(p.lastGroupId):'私聊'} · ${p.targetBot?'目标是机器人':'目标不是机器人'}`:'尚未接收到拍一拍事件。请确认 QQ 在线、目标为机器人，并在 NapCat 启用通知事件上报。'}
  function updateDiagnostics(p){const el=document.getElementById('ccPokeStatus');if(el)el.innerHTML=diagnosticText(p)}
  function collect(){
    const g=id=>document.getElementById(id),v=id=>g(id)?.value||'',on=id=>g(id)?.checked===true
    const groups=[...document.querySelectorAll('[data-cc-group]:checked')].map(x=>Number(x.value))
    for(const s of v('ccExtraGroups').split(/[\s,，]+/).filter(Boolean)){if(!/^\d+$/.test(s))throw Error('群号只能包含数字');groups.push(Number(s))}
    const mode=v('ccMode')||draft.responseMode||'fixed'
    return {...draft,name:v('ccName'),trigger:v('ccTrigger'),aliases:v('ccAliases').split(/[,，\n]/),event:v('ccEvent')||draft.event||'message',match:v('ccMatch')||draft.match||'exact',scope:v('ccScope'),groups:[...new Set(groups)],adminOnly:on('ccAdmin'),enabled:on('ccEnabled'),responseMode:mode,naturalLanguage:on('ccNatural'),description:v('ccDescription')||draft.description||'',reply:mode==='ai'?draft.reply||'':v('ccBody'),aiPrompt:mode==='ai'?v('ccBody'):draft.aiPrompt||'',cooldownSec:Number(v('ccCooldown')),scheduleEnabled:on('ccSchedule'),scheduleTimes:v('ccTimes').split(','),scheduleGroups:v('ccScheduleGroups').split(/[\s,，]+/).filter(Boolean)}
  }
  function bind({api,toast,load,render:rerender,ask}){
    const applyFilter=()=>{
      const q=(document.getElementById('ccSearch')?.value||'').trim().toLowerCase()
      const cat=document.getElementById('ccCat')?.value||'all'
      document.querySelectorAll('#ccBuiltinGrid .cc-item').forEach(el=>{ el.hidden=!((!q||el.dataset.search.includes(q))&&(cat==='all'||el.dataset.cat===cat)) })
    }
    if(document.getElementById('ccSearch'))document.getElementById('ccSearch').oninput=applyFilter
    if(document.getElementById('ccCat'))document.getElementById('ccCat').onchange=applyFilter
    const g=id=>document.getElementById(id),redraw=()=>{rerender();const ed=g('ccEditor');if(ed)ed.open=true;ed?.scrollIntoView({behavior:'smooth',block:'start'})}
    const safely=fn=>async ev=>{const b=ev?.currentTarget;if(b)b.disabled=true;try{await fn(ev)}catch(e){toast(e.message,true)}finally{if(b)b.disabled=false}}
    const reset=()=>{draft={enabled:false};builtin=false;redraw()}
    if(g('ccCreate'))g('ccCreate').onclick=reset
    if(g('ccNew'))g('ccNew').onclick=reset
    document.querySelectorAll('[data-cc-edit]').forEach(b=>b.onclick=()=>{draft=structuredClone(state.custom.find(c=>c.id===b.dataset.ccEdit));builtin=false;redraw()})
    document.querySelectorAll('[data-cc-builtin]').forEach(b=>b.onclick=()=>{draft=structuredClone(state.builtins.find(c=>c.id===b.dataset.ccBuiltin));builtin=true;redraw()})
    for(const type of ['toggle','toggle-builtin'])document.querySelectorAll(`[data-cc-${type}]`).forEach(b=>b.onclick=safely(async()=>{
      const id=b.getAttribute('data-cc-'+type),isBuiltin=type==='toggle-builtin',c=(isBuiltin?state.builtins:state.custom).find(x=>x.id===id)
      if(!c)return
      await api('/api/action/'+(isBuiltin?'save-builtin-command':'save-custom-command'),{...c,enabled:!c.enabled})
      c.enabled=!c.enabled
      const item=b.closest('.cc-item')
      if(item){const pill=item.querySelector('.pill');if(pill)pill.textContent=c.enabled?'已启用':'已关闭'}
      b.textContent=c.enabled?'关闭':'启用'
      toast('已更新开关')
    }))
    document.querySelectorAll('[data-cc-delete]').forEach(b=>b.onclick=safely(async()=>{if(!await ask('删除这条指令？','可以先导出保存一份。','删除'))return;await api('/api/action/delete-custom-command',{id:b.dataset.ccDelete});await load();toast('已删除')}))
    if(g('ccScope'))g('ccScope').onchange=()=>{g('ccGroupsBox').hidden=g('ccScope').value!=='group'}
    if(g('ccMode'))g('ccMode').onchange=()=>{const next=g('ccMode').value,previous=draft.responseMode||'fixed';g('ccMode').value=previous;draft=collect();draft.responseMode=next;redraw()}
    if(g('ccEditor'))g('ccEditor').addEventListener('input',ev=>{if(ev.target.id!=='ccMode')try{draft=collect()}catch{}})
    if(g('ccSave'))g('ccSave').onclick=safely(async()=>{draft=collect();await api('/api/action/'+(builtin?'save-builtin-command':'save-custom-command'),draft);draft={enabled:false};builtin=false;await load();toast('已保存，立即生效')})
    if(g('ccGenerate'))g('ccGenerate').onclick=safely(async()=>{
      const status=g('ccGenerateStatus')
      description=g('ccGenerateDescription').value
      generationMode=g('ccGenerateMode').value
      if(!String(description||'').trim()){status.textContent='请先写一句需求';toast('请先写一句需求',true);return}
      status.textContent='正在生成，尚未保存…'
      let timer=null
      try{
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('生成超时（45 秒），请检查模型接口是否可用')),45000)})
        const r=await Promise.race([api('/api/action/generate-command',{description,mode:generationMode}),timeout])
        draft=r.draft;builtin=false
        status.textContent='已生成草稿，请检查后保存'
        redraw();toast('草稿已填入下方表单，请检查后保存')
      }catch(e){
        status.textContent='生成失败：'+(e.message||'未知错误')
        toast('生成失败：'+(e.message||'未知错误'),true)
      }finally{ if(timer)clearTimeout(timer) }
    })
    if(g('ccPokeCheck'))g('ccPokeCheck').onclick=safely(async()=>{const r=await api('/api/action/check-poke',{});updateDiagnostics(r.diagnostics);toast(r.note)})
    document.querySelectorAll('[data-cc-export]').forEach(b=>b.onclick=safely(async()=>{const id=b.dataset.ccExport||null,pack=await api('/api/action/export-commands',{id,includeGroups:g('ccExportGroups')?.checked===true});const url=URL.createObjectURL(new Blob([JSON.stringify(pack,null,2)],{type:'application/json;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='Koukou-指令'+(id?'-'+id:'')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}))
    if(g('ccImportFile'))g('ccImportFile').onchange=safely(async ev=>{const f=ev.target.files[0];if(!f)return;if(!/\.json$/i.test(f.name)||f.size>262144)throw Error('请选择不超过256 KB的JSON文件');importContent=await f.text();preview=await api('/api/action/preview-commands',{content:importContent});rerender();g('ccImportPreview')?.scrollIntoView({behavior:'smooth'})})
    if(g('ccImportCancel'))g('ccImportCancel').onclick=()=>{preview=null;importContent='';rerender()}
    if(g('ccImportCommit'))g('ccImportCommit').onclick=safely(async()=>{const r=await api('/api/action/import-commands',{content:importContent,includeBuiltins:g('ccImportBuiltins').checked});preview=null;importContent='';await load();toast(`已导入 ${r.added} 条规则，默认关闭，请检查后启用`)})
  }
  return {render,bind,updateDiagnostics}
})()
