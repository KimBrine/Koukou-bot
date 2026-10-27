// Loopback-only cross-language fixture: never imports the real SDK/connector.
import { createInterface } from 'node:readline'
import { createOfficialBridge } from '../bridge.mjs'
import path from 'node:path'
const directory=process.argv[2]
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const output=value=>console.log(JSON.stringify(value))
let connector, bot, sent=0
class FakeSDK {
  constructor(){this.handlers=new Map();bot=this}
  on(name,callback){this.handlers.set(name,callback)}
  start(){this.handlers.get('ready')?.();return Promise.resolve()}
  stop(){}
  async sendText(target,text){output({event:'sent',target,text});return {id:'sdk-message/'+(++sent)+'='}}
  async sendImage(target){output({event:'image',target});return {message:{id:'sdk-image/'+(++sent)+'='}}}
  async recallMessage(){return {}}
}
const bridge=await createOfficialBridge({token:'loopback-test-token-with-at-least-32-characters',
  credentialsFile:path.join(directory,'credentials.json'),stateDir:path.join(directory,'bridge'),
  port:0,enableQQ:true,sdkFactory:()=>new FakeSDK(),renderQR:async()=>png,
  connectorStart:callbacks=>{connector=callbacks;void callbacks.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture');return ()=>{}}})
await bridge.start();output({event:'ready',port:bridge.server.address().port})
const input=createInterface({input:process.stdin})
input.on('line',async line=>{
  try {
    const value=JSON.parse(line)
    if(value.op==='scan')await connector.onSuccess([{appId:'fixture-app',appSecret:'test-fixture-not-a-real-app-secret'}])
    if(value.op==='message')bot.handlers.get('message')?.({message:{kind:'group',senderId:'fixture-user',
      groupOpenid:'fixture-group',messageId:value.mid,timestamp:new Date().toISOString(),content:value.text,
      rawEventType:value.directed===false?'GROUP_MESSAGE_CREATE':'GROUP_AT_MESSAGE_CREATE'}})
    if(value.op==='stop'){await bridge.close();input.close()}
  }catch{output({event:'fixture-error'});await bridge.close();input.close();process.exitCode=1}
})
