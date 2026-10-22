import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {request} from 'node:http'
import {createAdminServer} from '../src/admin/server.js'
import {quarantineCorrupt} from '../src/stateFile.js'
import {createStickers} from '../src/stickers.js'
import {MemoryStore} from '../src/memory.js'
import {createLongMemory} from '../src/longMemory.js'

const root=mkdtempSync(path.join(os.tmpdir(),'merge-guards-')),logger={info(){},warn(){},error(){}}
let server
try{
 const admin=createAdminServer({config:{rootDir:root,dataDir:root},logger})
 server=await admin.start(0)
 const base=`http://127.0.0.1:${server.address().port}`
 const html=await (await fetch(base)).text()
 const token=JSON.parse(html.match(/window\.__ADMIN_TOKEN__=("[^"]+")/)[1])
 const url=base+'/api/action/qq-login-state'
 const send=headers=>fetch(url,{method:'POST',headers,body:'{}'})
 assert.equal((await send({'Content-Type':'application/json'})).status,401)
 assert.equal((await send({'Content-Type':'application/json','X-Admin-Token':token,Origin:'https://example.invalid'})).status,403)
 assert.equal((await send({'Content-Type':'text/plain','X-Admin-Token':token})).status,415)
 const hostStatus=await new Promise((resolve,reject)=>{
   const req=request(url,{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':token,Host:'untrusted.invalid'}},res=>{res.resume();resolve(res.statusCode)})
   req.on('error',reject);req.end('{}')
 })
 assert.equal(hostStatus,403)
 assert.equal((await send({'Content-Type':'application/json','X-Admin-Token':token,Origin:base})).status,200)
 const corrupt=path.join(root,'broken.json');writeFileSync(corrupt,'{broken')
 const kept=quarantineCorrupt(corrupt);assert.equal(existsSync(corrupt),false);assert.equal(readFileSync(kept,'utf8'),'{broken')
 assert.throws(()=>quarantineCorrupt(path.join(root,'missing')),e=>e.code==='STATE_QUARANTINE_FAILED')
 const dir=path.join(root,'stickers');mkdirSync(dir);writeFileSync(path.join(dir,'learning-state.json'),'{broken')
 assert.equal(createStickers({dir,logger}).learningAllowed(),false)
 assert.equal(createStickers({dir,logger}).learningAllowed(),false,'损坏后暂停状态跨重启保留')
 const file=path.join(root,'memory.json');writeFileSync(file,'{"g1":[{"role":"user","content":"old"}]}');writeFileSync(file+'.reset.json','{broken')
 assert.throws(()=>new MemoryStore({file,logger,limit:20}).load(),/边界/)
 assert.equal(existsSync(file+'.reset.json'),true,'损坏边界必须保留在原位，不能让下次重启跳过')
 assert.match(readFileSync(file,'utf8'),/old/)
 writeFileSync(file+'.state.json','{broken')
 assert.throws(()=>createLongMemory({file,logger,llm:{}}),/边界/)
 assert.equal(existsSync(file+'.state.json'),true)
 console.log('Merge guards passed: real local HTTP auth/CSRF/Host, corrupt-file preservation, memory reset boundaries and paused sticker learning. No QQ or model calls.')
}finally{
 if(server)await new Promise(resolve=>{server.closeAllConnections();server.close(resolve)})
 assert.equal(path.dirname(root),os.tmpdir());rmSync(root,{recursive:true,force:true})
}
