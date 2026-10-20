/* 上传草稿独立保存，轮询与页面切换不丢文件；AI只补空白字段。 */
window.StickerUploadUI=(()=>{
  let drafts=[],busy=false,reading=0,scenes=[],tools=null,batchKeywords='',batchScenes=[]
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const disabled=()=>busy?' disabled':''
  function render(sceneList=[]){scenes=sceneList;return `<section class="card" id="stickerUploadPanel"><h2>上传表情包 <span class="pill">待上传 ${drafts.length} 张</span></h2>
    <div id="stkDrop" class="sticker-drop" role="button" tabindex="0" aria-label="拖拽或选择表情包图片"><strong>把图片拖到这里</strong><span>或点击选择图片 · 支持多张 PNG / JPEG / WebP / GIF</span><small>单张最多4MB，一批最多20张。选择图片只创建草稿，不会立即入库。</small></div>
    <input type="file" id="stkFile" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    <div class="flexbar"><button class="btn" id="stkChoose"${disabled()}>选择图片</button><button class="btn" id="stkFillAll"${disabled()}>AI一键补全空白项</button><button class="btn primary" id="stkUpload"${disabled()}>上传全部草稿</button></div>
    <details><summary>批量追加标签与场景</summary><input id="stkKw" value="${esc(batchKeywords)}" placeholder="统一关键词，可用空格或逗号分隔"${disabled()}>${scenes.map(s=>`<label class="chk"><input type="checkbox" data-upload-batch-scene value="${esc(s.id)}"${batchScenes.includes(s.id)?' checked':''}${disabled()}>${esc(s.name)}</label>`).join('')}<button class="btn" id="stkBatchApply"${disabled()}>追加到全部草稿</button></details>
    <p class="mut">AI使用表情包第二轮复核/打标模型，点击后才调用API；已填写内容不覆盖。请检查生成的名称、标签、描述与场景后再上传。</p><div id="stkDrafts" class="sticker-drafts">${drafts.map(d=>`<article class="upload-draft" data-upload-card="${d.id}"><img src="${esc(d.dataUrl)}" alt="${esc(d.filename)}"><div class="mut">${esc(d.filename)} · ${Math.ceil(d.size/1024)} KB</div>
    <label>名称<input data-upload-field="name" data-upload-id="${d.id}" value="${esc(d.name)}" maxlength="40" placeholder="留空时使用文件名"${disabled()}></label>
    <label>标签<input data-upload-field="keywords" data-upload-id="${d.id}" value="${esc(d.keywords)}" placeholder="空格或逗号分隔"${disabled()}></label>
    <label>描述<textarea data-upload-field="description" data-upload-id="${d.id}" maxlength="1000" rows="3" placeholder="画面含义、适用与不适用的语境"${disabled()}>${esc(d.description)}</textarea></label>
    <details><summary>适用场景</summary>${scenes.map(s=>`<label class="chk"><input type="checkbox" data-upload-scene="${d.id}" value="${esc(s.id)}"${d.scenes.includes(s.id)?' checked':''}${disabled()}>${esc(s.name)}</label>`).join('')}</details>
    <p class="mut" role="status">${esc(d.status||'待编辑，可直接上传')}</p><div class="flexbar"><button class="btn" data-upload-ai="${d.id}"${disabled()}>AI补全</button><button class="btn" data-upload-remove="${d.id}"${disabled()}>移除草稿</button></div></article>`).join('')}</div></section>`}
  function redraw(){const panel=document.getElementById('stickerUploadPanel');if(!panel)return;panel.outerHTML=render(scenes);bind(tools)}
  async function addFiles(files){
    if(busy||reading)return
    reading++
    try{for(const f of Array.from(files||[])){
      if(drafts.length>=20){tools.toast('一批最多20张，请先上传或移除部分草稿',true);break}
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(f.type)||!f.size||f.size>4*1024*1024){tools.toast(f.name+'：请选择4MB以内的PNG/JPEG/WebP/GIF图片',true);continue}
      const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('图片读取失败'));r.readAsDataURL(f)})
      if(drafts.some(d=>d.dataUrl===dataUrl))continue
      drafts.push({id:crypto.randomUUID(),filename:f.name,size:f.size,dataUrl,name:'',keywords:'',description:'',scenes:[],status:''})
    }}catch(e){tools.toast(e.message,true)}finally{reading--;redraw()}
  }
  async function fill(list){
    if(busy||reading||!list.length)return
    busy=true;redraw()
    try{for(const d of list){
      if(d.name.trim()&&d.keywords.trim()&&d.description.trim()&&d.scenes.length){d.status='已填写完整，跳过AI';continue}
      d.status='AI正在补全…';redraw()
      try{const r=await tools.api('/api/action/sticker-suggest',{dataUrl:d.dataUrl}),v=r.draft
        for(const k of ['name','keywords','description'])if(!d[k].trim())d[k]=k==='keywords'?v.keywords.join(' '):v[k]
        if(!d.scenes.length)d.scenes=v.scenes||[]
        d.status='已由 '+v.model+' 补全，请检查后上传'
      }catch(e){d.status='补全失败：'+e.message+'；草稿已保留'}
      redraw()
    }}finally{busy=false;redraw()}
  }
  async function upload(){
    if(busy||reading)return
    if(!drafts.length){tools.toast('先拖入或选择图片',true);return}
    busy=true;redraw();let count=0
    try{for(const d of [...drafts]){
      d.status='上传中…';redraw()
      try{await tools.api('/api/action/sticker-add',{dataUrl:d.dataUrl,name:d.name.trim()||d.filename.replace(/\.[^.]+$/,''),keywords:d.keywords,description:d.description,scenes:d.scenes});drafts=drafts.filter(x=>x.id!==d.id);count++}
      catch(e){d.status='上传失败：'+e.message+'；可修改后重试'}
      redraw()
    }}finally{busy=false;await tools.onSaved();redraw();tools.toast('已处理 '+count+' 张，失败草稿保留')}
  }
  function bind(options){tools=options;if(!tools)return;const g=id=>document.getElementById(id),drop=g('stkDrop'),file=g('stkFile')
    if(!drop||!file)return
    const choose=()=>{if(!busy&&!reading)file.click()}
    drop.onclick=choose;drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose()}}
    drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragging')};drop.ondragleave=()=>drop.classList.remove('dragging')
    drop.ondrop=e=>{e.preventDefault();drop.classList.remove('dragging');addFiles(e.dataTransfer.files)}
    file.onchange=()=>addFiles(file.files);g('stkChoose').onclick=choose;g('stkFillAll').onclick=()=>fill([...drafts]);document.getElementById('stkUpload').onclick=upload
    const batchInput=g('stkKw');if(batchInput)batchInput.oninput=()=>batchKeywords=batchInput.value
    document.querySelectorAll('[data-upload-batch-scene]').forEach(el=>el.onchange=()=>{batchScenes=Array.from(document.querySelectorAll('[data-upload-batch-scene]:checked')).map(e=>e.value)})
    const batchApply=g('stkBatchApply');if(batchApply)batchApply.onclick=()=>{if(busy)return;for(const d of drafts){d.keywords=[...new Set((d.keywords+' '+batchKeywords).split(/[,，\s]+/).filter(Boolean))].join(' ');d.scenes=[...new Set([...d.scenes,...batchScenes])]}redraw()}
    document.querySelectorAll('[data-upload-field]').forEach(el=>el.oninput=()=>{const d=drafts.find(d=>d.id===el.dataset.uploadId);if(d)d[el.dataset.uploadField]=el.value})
    document.querySelectorAll('[data-upload-scene]').forEach(el=>el.onchange=()=>{const d=drafts.find(d=>d.id===el.dataset.uploadScene);if(d)d.scenes=Array.from(document.querySelectorAll(`[data-upload-scene="${d.id}"]:checked`)).map(e=>e.value)})
    document.querySelectorAll('[data-upload-ai]').forEach(el=>el.onclick=()=>fill(drafts.filter(d=>d.id===el.dataset.uploadAi)))
    document.querySelectorAll('[data-upload-remove]').forEach(el=>el.onclick=()=>{if(busy)return;drafts=drafts.filter(d=>d.id!==el.dataset.uploadRemove);redraw()})
  }
  return {render,bind,dirty:()=>busy||reading>0||drafts.length>0}
})()
