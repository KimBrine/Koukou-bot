import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

export const PROTOCOL = 'koukou-qq-official-v1'
export const SDK_VERSION = '1.0.5'
export const CAPABILITIES = Object.freeze({ text:true, image:true, ownRecall:true, file:false,
  completeHistory:false, members:false, moderation:false, poke:false, proactive:false })
const IMAGE_MAX = 4 * 1024 * 1024
const STATE_MAX = 10000
const QR_LIFETIME_MS = 120000
const QR_PREPARE_MS = 30000
const MARKER = '.koukou-qq-official.json'
const FORBIDDEN_STATE = ['memory.json','long-memory.json','bot.lock','bot-start.guard','personas','stickers']

class BridgeError extends Error {
  constructor(code, message, outcomeUnknown=false) { super(message); this.code=code; this.outcomeUnknown=outcomeUnknown }
}
const reject = (code,message) => { throw new BridgeError(code,message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const equal = (a,b) => typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a),Buffer.from(b))
const tokenId = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const messageId = value => typeof value==='string' && /^[^\s\x00-\x1f\x7f]{1,1024}$/u.test(value)
const keyFor = (app,scope,target,id) => JSON.stringify([app,scope,target,id])

async function safePath(value) {
  if (typeof value!=='string' || !path.isAbsolute(value)) reject('PRIVATE_PATH_REQUIRED','必须明确指定绝对私有路径')
  const selected=path.resolve(value)
  let current=selected
  for (;;) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) reject('LINKED_PATH','私有状态路径不能是链接') }
    catch (error) { if (error.code!=='ENOENT') throw error }
    const parent=path.dirname(current)
    if (parent===current) break
    current=parent
  }
  return selected
}
async function readJson(file) {
  const info=await fs.stat(file)
  if (!info.isFile() || info.size>16*1024*1024) reject('INVALID_STATE','私有状态文件无效')
  return JSON.parse(await fs.readFile(file,'utf8'))
}
async function atomicJson(file,value,current=()=>true) {
  await safePath(file)
  const temporary=file+'.'+randomUUID()+'.tmp'
  let handle
  try {
    handle=await fs.open(temporary,'wx',0o600)
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle=null
    if (!await current()) reject('STALE_BINDING','绑定已取消或凭据已变化，未替换原文件')
    await fs.rename(temporary,file)
    await fs.chmod(file,0o600)
  } finally {
    await handle?.close().catch(()=>{})
    await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})
  }
}
function credentials(value) {
  if (!object(value) || value.protocol!==PROTOCOL || value.version!==1 || !tokenId(value.appId)
    || typeof value.appSecret!=='string' || value.appSecret.length<8 || value.appSecret.length>4096
    || /[\r\n\0]/.test(value.appSecret)) reject('INVALID_CREDENTIALS','凭据格式无效，未覆盖原文件')
  return { appId:value.appId, appSecret:value.appSecret }
}
function picture(segment) {
  const mime=segment.mime
  if (!['image/png','image/jpeg','image/gif','image/webp'].includes(mime)
    || typeof segment.base64!=='string' || segment.base64.length>Math.ceil(IMAGE_MAX/3)*4
    || segment.base64.length%4!==0 || /[^A-Za-z0-9+/=]/.test(segment.base64)) reject('INVALID_IMAGE','图片格式或大小无效')
  const buffer=Buffer.from(segment.base64,'base64')
  if (!buffer.length || buffer.length>IMAGE_MAX || buffer.toString('base64')!==segment.base64) reject('INVALID_IMAGE','图片格式或大小无效')
  const actual=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png'
    : buffer[0]===255 && buffer[1]===216 && buffer[2]===255?'image/jpeg'
    : ['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString())?'image/gif'
    : buffer.subarray(0,4).toString()==='RIFF' && buffer.subarray(8,12).toString()==='WEBP'?'image/webp':''
  if (actual!==mime) reject('INVALID_IMAGE','图片内容与类型不符')
  return buffer
}
function normalizeMessage(message) {
  if (!object(message) || !['c2c','group'].includes(message.kind) || !tokenId(message.senderId)
    || !messageId(message.messageId) || (message.kind==='group' && !tokenId(message.groupOpenid))) return null
  const result={ kind:message.kind, senderId:message.senderId, messageId:message.messageId,
    timestamp:String(message.timestamp||''), content:String(message.content||'').slice(0,128000) }
  for (const field of ['groupOpenid','senderName','rawEventType','refMsgIdx','msgIdx','msgType','senderIsBot']) {
    if (['string','number','boolean'].includes(typeof message[field])) result[field]=message[field]
  }
  for (const field of ['attachments','mentions','msgElements']) {
    if (Array.isArray(message[field]) && message[field].length<=100) result[field]=structuredClone(message[field])
  }
  if (object(message.messageScene)) result.messageScene=structuredClone(message.messageScene)
  return result
}

/** Starts only a local transport. QQ and QR activity always require enableQQ. */
export async function createOfficialBridge({ token, credentialsFile, stateDir, port=8792, enableQQ=false,
  sdkFactory, connectorStart, renderQR, now=()=>Date.now(), qrTimers={setTimeout,clearTimeout} }={}) {
  if (typeof token!=='string' || token.length<32 || token.length>4096 || /[\s\0]/.test(token)) reject('TOKEN_REQUIRED','桥接令牌须至少32个无空白字符')
  if (!Number.isInteger(port) || port<0 || port>65535) reject('INVALID_PORT','本机端口无效')
  stateDir=await safePath(stateDir); credentialsFile=await safePath(credentialsFile)
  await fs.mkdir(stateDir,{recursive:true,mode:0o700})
  const entries=await fs.readdir(stateDir)
  if (FORBIDDEN_STATE.some(name=>entries.includes(name))) reject('INSTANCE_DATA_REFUSED','不能复用机器人实例的数据目录')
  const markerFile=path.join(stateDir,MARKER)
  if (!entries.includes(MARKER)) {
    if (entries.length) reject('NONEMPTY_STATE_DIR','请选择新的独立桥接状态目录')
    await atomicJson(markerFile,{protocol:PROTOCOL,version:1})
  } else {
    const marker=await readJson(await safePath(markerFile))
    if (marker?.protocol!==PROTOCOL || marker.version!==1) reject('INVALID_STATE','桥接状态目录不匹配')
  }
  if (!(await fs.stat(path.dirname(credentialsFile))).isDirectory()) reject('CREDENTIAL_PARENT_REQUIRED','凭据文件的父目录必须存在')
  let creds=null
  try {creds=credentials(await readJson(credentialsFile))} catch(error) {if(error.code!=='ENOENT')throw error}
  const ledgerFile=path.join(stateDir,'own-messages.json')
  const lockFile=path.join(stateDir,'.bridge.lock')
  const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b
  if([markerFile,ledgerFile,lockFile].some(file=>samePath(credentialsFile,file)))reject('INVALID_CREDENTIAL_PATH','凭据不能覆盖桥接状态文件')
  let ledger={protocol:PROTOCOL,version:1,sent:{},requests:{}}
  try {ledger=await readJson(await safePath(ledgerFile))} catch(error) {if(error.code!=='ENOENT')throw error}
  if (ledger?.protocol!==PROTOCOL || ledger.version!==1 || !object(ledger.sent) || !object(ledger.requests)
    || Object.keys(ledger.sent).length>STATE_MAX || Object.keys(ledger.requests).length>STATE_MAX) reject('INVALID_STATE','发送状态损坏，禁止发送和撤回')
  for (const [key,record] of Object.entries(ledger.sent)) {
    if (!object(record) || !tokenId(record.appId) || !['group','c2c'].includes(record.scope) || !tokenId(record.targetId)
      || !messageId(record.messageId) || !['confirmed','recalled','recall-pending','unknown'].includes(record.state)
      || key!==keyFor(record.appId,record.scope,record.targetId,record.messageId)) reject('INVALID_STATE','自有消息记录损坏')
  }
  for (const record of Object.values(ledger.requests)) {
    if (!object(record) || !/^[a-f0-9]{64}$/.test(record.hash) || !['pending','done'].includes(record.state)
      || (record.state==='done' && !object(record.response))) reject('INVALID_STATE','发送请求记录损坏')
  }
  const lockToken=randomUUID()
  let lock
  try {lock=await fs.open(lockFile,'wx',0o600)}catch(error){if(error.code==='EEXIST')reject('BRIDGE_ALREADY_RUNNING','独立桥接目录已有实例锁，请先核对原实例');throw error}
  try{await lock.writeFile(JSON.stringify({protocol:PROTOCOL,pid:process.pid,token:lockToken}));await lock.sync()}finally{await lock.close()}
  let online=false, phase=creds?'bound':'unbound', qrDataUrl, sdk=null, generation=0, bindingStop=null, bindingActive=false, stopped=false
  let qrUrl, issuedAt, refreshAt, bindingMessage='', qrRevision=0, qrTimer=null
  const clearQrTimer=()=>{if(qrTimer!==null)qrTimers.clearTimeout(qrTimer);qrTimer=null}
  const clearQr=()=>{qrRevision++;qrDataUrl=undefined;qrUrl=undefined;issuedAt=undefined;refreshAt=undefined;clearQrTimer()}
  const armQrTimer=(delay,callback)=>{clearQrTimer();qrTimer=qrTimers.setTimeout(callback,delay);qrTimer?.unref?.()}
  let serial=Promise.resolve(), storageHealthy=true
  const triggers=new Map(), inflight=new Map(), clients=new Set()
  const persist=()=>{const work=serial.then(()=>atomicJson(ledgerFile,ledger));serial=work.catch(()=>{});return work}
  const status=()=>({ protocol:PROTOCOL,appId:creds?.appId||'',online,capabilities:{...CAPABILITIES},
    binding:{phase,...(qrDataUrl?{qrDataUrl,qrUrl,issuedAt,refreshAt}:{}),...(bindingMessage?{message:bindingMessage}:{})},sdkVersion:SDK_VERSION })
  function broadcast(value) {const data=JSON.stringify(value);for(const client of clients)if(client.readyState===WebSocket.OPEN)client.send(data)}
  const changed=()=>broadcast({type:'qq-status',data:status()})
  async function loadSDK(options) {
    if (sdkFactory) return sdkFactory(options)
    const {QQBot}=await import('@tencent-connect/qqbot-nodejs')
    return new QQBot(options)
  }
  async function connect() {
    if (!enableQQ || !creds || stopped) return
    const current=++generation, selected=creds
    sdk?.stop(); sdk=null; online=false;phase='connecting';clearQr();bindingMessage='';changed()
    const instance=await loadSDK({appId:selected.appId,appSecret:selected.appSecret,transport:'websocket',
      markdownSupport:false,baseUrl:'https://api.bot.qq.com',tokenBaseUrl:'https://api.bot.qq.com',
      logger:{info(){},warn(){},debug(){},error(){}}})
    if (stopped || current!==generation) {instance.stop();return}
    sdk=instance
    instance.on('ready',()=>{if(current!==generation||stopped||!storageHealthy)return;online=true;phase='online';changed()})
    instance.on('resumed',()=>{if(current!==generation||stopped||!storageHealthy)return;online=true;phase='online';changed()})
    instance.on('disconnected',event=>{if(current!==generation||stopped)return;online=false;phase=event?.willReconnect?'connecting':'error';changed()})
    instance.on('error',()=>{if(current!==generation||stopped)return;online=false;phase='error';changed()})
    instance.on('message',(context,message)=>{
      if(current!==generation||stopped||!online)return
      const data=normalizeMessage(message||context?.message)
      if (!data) return
      const scope=data.kind,target=data.kind==='group'?data.groupOpenid:data.senderId
      const key=keyFor(selected.appId,scope,target,data.messageId)
      if (!triggers.has(key)) triggers.set(key,{at:now(),count:Object.values(ledger.requests).filter(record=>record.triggerKey===key).length})
      if (triggers.size>10000) triggers.delete(triggers.keys().next().value)
      broadcast({type:'qq-message',appId:selected.appId,data})
    })
    Promise.resolve(instance.start()).catch(()=>{if(current!==generation||stopped)return;online=false;phase='error';changed()})
  }
  async function bind(force=false) {
    if (!enableQQ) reject('QQ_DISABLED','当前未启用QQ连接，未发起扫码')
    if (stopped) reject('BRIDGE_CLOSED','桥接服务已关闭')
    if (online || phase==='connecting') return status()
    if (creds) {await connect();return status()}
    if(bindingActive && phase==='preparing' && !force)return status()
    // A manual start while showing a QR means a new task, never the old code.
    generation++;bindingActive=false;clearQr();bindingStop?.();bindingStop=null
    const current=++generation;bindingActive=true
    phase='preparing';bindingMessage='';changed()
    const failed=message=>{if(current!==generation||stopped)return;generation++;bindingActive=false;clearQr();bindingStop?.();bindingStop=null;phase='error';bindingMessage=message;changed()}
    const preparingTimeout=()=>failed('获取新二维码超时，请重新生成；未保留旧二维码。')
    armQrTimer(QR_PREPARE_MS,preparingTimeout)
    try {
    const start=connectorStart||((await import('@tencent-connect/qqbot-connector')).startQrConnect)
    const renderer=renderQR|| (async url=>{const qr=await import('qrcode');return qr.default.toDataURL(url,{type:'image/png',width:360,margin:4,errorCorrectionLevel:'M'})})
    if(current!==generation||stopped)return status()
    const cancel=start({
      onQrDisplayed:async url=>{
        if(current!==generation||stopped)return
        const revision=++qrRevision
        clearQrTimer();qrDataUrl=undefined;qrUrl=undefined;issuedAt=undefined;refreshAt=undefined
        phase='preparing';changed();armQrTimer(QR_PREPARE_MS,preparingTimeout)
        try {
          const selected=new URL(url)
          if(selected.origin!=='https://q.qq.com'||selected.username||selected.password||selected.hash||selected.pathname!=='/qqbot/openclaw/connect.html'
            ||!selected.searchParams.get('task_id')||url.length>8192)throw Error()
          const rendered=await renderer(url);if(current!==generation||revision!==qrRevision||stopped)return
          if(typeof rendered!=='string'||!rendered.startsWith('data:image/png;base64,')||rendered.length>300000)throw Error()
          phase='qr';qrDataUrl=rendered;qrUrl=url;issuedAt=now();refreshAt=issuedAt+QR_LIFETIME_MS;changed()
          armQrTimer(QR_LIFETIME_MS,()=>{if(current===generation&&!stopped)void bind(true).catch(()=>failed('二维码刷新失败，请重新生成。'))})
        }catch{if(revision===qrRevision)failed('二维码生成失败，请重新生成。')}
      },
      onQrExpired:()=>{if(current!==generation||stopped)return;clearQr();phase='preparing';changed();armQrTimer(QR_PREPARE_MS,preparingTimeout)},
      onFailure:()=>failed('官方扫码连接失败，请检查网络后重新生成二维码。'),
      onSuccess:async values=>{
        if(current!==generation||stopped)return
        const saving=++generation
        clearQr();bindingStop?.();bindingStop=null
        try {
          const value=values?.[0],selected=credentials({protocol:PROTOCOL,version:1,appId:value?.appId,appSecret:value?.appSecret})
          await atomicJson(credentialsFile,{protocol:PROTOCOL,version:1,...selected},async()=>{
            if(saving!==generation||stopped)return false
            try{await fs.lstat(credentialsFile);return false}catch(error){if(error.code!=='ENOENT')throw error;return true}
          })
          if(saving!==generation||stopped)return
          creds=selected;bindingActive=false;phase='bound';changed();await connect()
        } catch {if(saving===generation&&!stopped){bindingActive=false;phase='error';bindingMessage='绑定凭据未能安全保存，请重新生成二维码。';changed()}}
      },
    },{displayQrCodeToConsole:false})
    if(current===generation&&bindingActive&&!stopped)bindingStop=cancel
    else cancel?.()
    } catch {failed('无法启动官方扫码连接，请检查连接器和网络后重新生成。')}
    return status()
  }
  function target(params) {
    if (!object(params)||!['group','c2c'].includes(params.scope)||!tokenId(params.targetId)) reject('INVALID_TARGET','目标类型或OpenID无效')
    return {scope:params.scope,targetId:params.targetId}
  }
  function requireOnline() {if(!storageHealthy)reject('STATE_UNAVAILABLE','发送状态不可写，已停止接受QQ操作');if(!enableQQ||!online||!sdk||!creds)reject('QQ_OFFLINE','QQ尚未连接，未发送请求')}
  async function mutation(action,params,echo,work) {
    const requestKey=JSON.stringify([creds.appId,echo])
    const hash=createHash('sha256').update(JSON.stringify([action,params])).digest('hex')
    const old=ledger.requests[requestKey]
    if (old) {
      if (old.hash!==hash)reject('ECHO_REUSED','请求编号已用于其他内容')
      if (inflight.has(requestKey))return inflight.get(requestKey)
      if (old.state==='done')return old.response
      throw new BridgeError('PREVIOUS_OUTCOME_UNKNOWN','此前请求结果未确认，不会重试',true)
    }
    if (Object.keys(ledger.requests).length>=STATE_MAX || Object.keys(ledger.sent).length>=STATE_MAX)reject('STATE_CAPACITY','发送状态已满，请先人工检查')
    ledger.requests[requestKey]={hash,state:'pending',...(action==='qq.send'?{triggerKey:keyFor(creds.appId,params.scope,params.targetId,params.msgId)}:{})}
    const promise=(async()=>{
      try {await persist()}catch{storageHealthy=false;online=false;phase='error';changed();throw new BridgeError('STATE_WRITE_FAILED','无法持久化发送意图，未执行QQ操作')}
      let response
      try {response={echo,status:'ok',retcode:0,data:await work()}}
      catch(error) {const definite=error instanceof BridgeError? !error.outcomeUnknown
        : Number.isInteger(error?.httpStatus)&&error.httpStatus>=400&&error.httpStatus<500&&![408,429].includes(error.httpStatus)
        response={echo,status:'failed',retcode:1,code:error instanceof BridgeError?error.code:'QQ_REQUEST_FAILED',
          message:error instanceof BridgeError?error.message:'官方请求结果未获确认',outcomeUnknown:!definite}}
      ledger.requests[requestKey]={...ledger.requests[requestKey],state:'done',response}
      try {await persist()}catch{
        ledger.requests[requestKey]={...ledger.requests[requestKey],state:'pending'}
        delete ledger.requests[requestKey].response
        storageHealthy=false;online=false;phase='error';changed()
        throw new BridgeError('STATE_WRITE_FAILED','请求结果未能持久化，不会重试',true)
      }
      return response
    })()
    inflight.set(requestKey,promise)
    try{return await promise}finally{inflight.delete(requestKey)}
  }
  async function dispatch(request) {
    const echo=object(request)&&((typeof request.echo==='string'&&request.echo.length>0&&request.echo.length<=128)||Number.isSafeInteger(request.echo))?request.echo:null
    try {
      if(echo===null||!object(request)||typeof request.action!=='string'||!object(request.params||{}))reject('INVALID_REQUEST','请求格式无效')
      const params=request.params||{}
      if(request.action==='qq.status')return {echo,status:'ok',retcode:0,data:status()}
      if(request.action==='qq.binding.start')return {echo,status:'ok',retcode:0,data:await bind()}
      if(request.action==='qq.binding.cancel') {
        if(bindingActive){generation++;bindingActive=false;clearQr();bindingStop?.();bindingStop=null;phase='canceled';bindingMessage='';changed()}
        return {echo,status:'ok',retcode:0,data:status()}
      }
      if (!['qq.send','qq.recall'].includes(request.action))reject('UNSUPPORTED_ACTION','官方接入暂不支持此操作')
      requireOnline();const selected=target(params), appId=creds.appId, instance=sdk, current=generation
      if(request.action==='qq.send') {
        if(!messageId(params.msgId))reject('PASSIVE_REPLY_REQUIRED','当前仅支持回复已接收的消息，未主动发送')
        if(!Array.isArray(params.segments)||!params.segments.length||params.segments.length>64)reject('INVALID_SEGMENTS','消息内容无效')
        const types=new Set(params.segments.map(item=>object(item)?item.type:null))
        if(types.size!==1||![...types].every(type=>['text','image'].includes(type)))reject('UNSUPPORTED_SEGMENTS','每次只支持纯文字或单张图片')
        let text,buffer
        if(types.has('text')) {if(params.segments.some(item=>typeof item.text!=='string'))reject('INVALID_TEXT','文字内容无效')
          text=params.segments.map(item=>item.text).join('');if(!text.trim()||text.length>4500||/[\0\u001b]/.test(text))reject('INVALID_TEXT','文字为空或超过单条长度')
        }else{if(params.segments.length!==1)reject('UNSUPPORTED_SEGMENTS','每次只支持单张图片');buffer=picture(params.segments[0])}
        return await mutation(request.action,params,echo,async()=>{
          if(current!==generation||instance!==sdk||!online)reject('SESSION_CHANGED','连接已变化，未发送消息')
          const trigger=triggers.get(keyFor(appId,selected.scope,selected.targetId,params.msgId))
          const ttl=selected.scope==='group'?5*60*1000:30*60*1000
          if(!trigger||now()-trigger.at>=ttl||trigger.count>=4)reject('PASSIVE_REPLY_EXPIRED','被动回复窗口已过期或次数已用完')
          trigger.count++ // An uncertain outcome still consumes this attempt.
          const reply={...selected,msgId:params.msgId}
          const raw=text!==undefined?await instance.sendText(reply,text):await instance.sendImage(reply,{buffer})
          const id=text!==undefined?raw?.id:raw?.message?.id
          if(!messageId(id))throw new BridgeError('MISSING_RECEIPT','官方发送回执缺少消息ID，不会重试',true)
          ledger.sent[keyFor(appId,selected.scope,selected.targetId,id)]={appId,...selected,messageId:id,state:'confirmed'}
          return {messageId:id}
        })
      }
      if(!messageId(params.messageId))reject('INVALID_MESSAGE_ID','消息ID无效')
      const ownedKey=keyFor(appId,selected.scope,selected.targetId,params.messageId)
      return await mutation(request.action,params,echo,async()=>{
        if(current!==generation||instance!==sdk||!online)reject('SESSION_CHANGED','连接已变化，未撤回')
        if(ledger.sent[ownedKey]?.state!=='confirmed')reject('NOT_OWN_MESSAGE','只允许撤回本桥确认发送的自有消息')
        ledger.sent[ownedKey].state='recall-pending';await persist()
        try{await instance.recallMessage(selected,params.messageId)}catch(error){
          ledger.sent[ownedKey].state=Number.isInteger(error?.httpStatus)&&error.httpStatus>=400&&error.httpStatus<500&&![408,429].includes(error.httpStatus)?'confirmed':'unknown'
          throw error
        }
        ledger.sent[ownedKey].state='recalled'
        return {recalled:true}
      })
    }catch(error){return {echo,status:'failed',retcode:1,code:error instanceof BridgeError?error.code:'BRIDGE_ERROR',
      message:error instanceof BridgeError?error.message:'桥接操作未获确认',outcomeUnknown:error instanceof BridgeError?error.outcomeUnknown:false}}
  }
  const server=createServer((_req,res)=>{res.writeHead(404,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Not found')})
  const websocket=new WebSocketServer({noServer:true,maxPayload:6*1024*1024,perMessageDeflate:false})
  server.on('upgrade',(req,socket,head)=>{
    const active=server.address()?.port
    const host=String(req.headers.host||'').toLowerCase()
    const origin=req.headers.origin
    let code=0
    if(![`127.0.0.1:${active}`,`localhost:${active}`].includes(host)||!['/bridge','/','/ws'].includes(req.url))code=403
    else if(origin&&!['http://127.0.0.1:'+active,'http://localhost:'+active].includes(origin))code=403
    else if(!equal(req.headers.authorization,'Bearer '+token))code=401
    if(code){socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);return}
    websocket.handleUpgrade(req,socket,head,client=>websocket.emit('connection',client,req))
  })
  websocket.on('connection',client=>{
    clients.add(client);client.send(JSON.stringify({type:'qq-status',data:status()}))
    client.on('close',()=>clients.delete(client));client.on('error',()=>{})
    client.on('message',async(data,binary)=>{
      let request
      try{if(binary)throw Error();request=JSON.parse(data.toString())}catch{request=null}
      const response=await dispatch(request)
      if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(response))
    })
  })
  return {status,dispatch,server,
    async start(){try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});if(enableQQ&&creds)await connect();return server.address()}catch(error){await this.close();throw error}},
    async close(){if(stopped)return;stopped=true;generation++;bindingActive=false;clearQr();bindingStop?.();bindingStop=null;sdk?.stop();sdk=null;online=false
      for(const client of clients)client.terminate();await new Promise(resolve=>websocket.close(resolve))
      if(server.listening)await new Promise(resolve=>server.close(resolve));await serial
      const current=await readJson(lockFile).catch(()=>null)
      if(current?.token===lockToken)await fs.unlink(lockFile)},
  }
}
