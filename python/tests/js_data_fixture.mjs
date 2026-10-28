// Build an offline fixture using the original JS writers. No config discovery,
// QQ connection, model call or production directory is permitted here.
import {mkdirSync, readdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {MemoryStore} from '../../src/memory.js'
import {createLongMemory} from '../../src/longMemory.js'
import {createChatSettings} from '../../src/chatSettings.js'
import {createCustomCommands} from '../../src/customCommands.js'
import {createCommandCenter} from '../../src/commandCenter.js'
import {createVisionProviders} from '../../src/visionProviders.js'
import {createPersonaGreetingLibrary} from '../../src/personaGreetings.js'
import {createPersonaStickers} from '../../src/personaStickers.js'
import {createImageCache} from '../../src/imageCache.js'
import {createDailySummary} from '../../src/dailySummary.js'
import {writeJsonAtomic} from '../../src/stateFile.js'

const dir=path.resolve(process.argv[2] || '')
if(!process.argv[2] || path.basename(dir)!=='js-data' || readdirSync(dir).length)throw Error('requires an empty js-data test directory')
const logger={info(){},warn(){},error(){}}
const config={dataDir:dir,activePersona:'SourceSample',personaRevision:0,summaryEnabled:true,
  summaryGroups:[123],whitelistGroups:new Set([123]),adminUsers:new Set([456])}
const memory=new MemoryStore({file:path.join(dir,'memory.json'),limit:99,logger})
memory.restore({chats:{g123:[{role:'user',content:'Generic source message',time:null}]},resetAt:0,keyResetAt:{}})
writeJsonAtomic(path.join(dir,'memory__SourceSample.json'),memory.snapshot())
const long=createLongMemory({file:path.join(dir,'long-memory.json'),logger,llm:{chat(){throw Error('no model in fixture')}}})
long.restore({chats:{g123:{summary:'Source summary',pending:[],updatedAt:0,paused:true,retry:null}},epoch:'legacy',keyEpochs:{}})
long.feed('g123',[{role:'user',content:'Source original',time:1,senderName:'Sample',userId:'456'}])
writeJsonAtomic(path.join(dir,'long-memory__SourceSample.json'),long.snapshot())
mkdirSync(path.join(dir,'personas'))
writeFileSync(path.join(dir,'personas','SourceSample.txt'),'A generic helpful persona.','utf8')
const settings=createChatSettings({file:path.join(dir,'chat-settings.json'),logger})
settings.set('g123',{persona:'SourceSample',quietHours:'01:00-07:00',proactiveRate:.04})
const custom=createCustomCommands({file:path.join(dir,'custom-commands.json'),logger})
custom.upsert({id:'sample',trigger:'/sample',reply:'Source sample reply',scope:'group',groups:[123]})
const center=createCommandCenter({file:path.join(dir,'command-center.json'),customCommands:custom,config,logger})
center.saveBuiltin({id:'summary',enabled:true,scope:'groups'})
const providers=createVisionProviders({file:path.join(dir,'vision-providers.json'),logger})
providers.add({name:'Sample provider',baseUrl:'https://example.com/v1',apiKey:'fixture-key',model:'fixture-vision'})
createPersonaGreetingLibrary({file:path.join(dir,'persona-greetings.json'),logger})
  .set('A generic helpful persona.',{goodmorning:['早上好'],goodnight:['晚安']})
const bytes=Buffer.from('89504e470d0a1a0a'+'00'.repeat(30),'hex')
const part={type:'image_url',image_url:{url:'data:image/png;base64,'+bytes.toString('base64')}}
const stickers=createPersonaStickers({dir:path.join(dir,'stickers'),config,chatSettings:settings,memory,logger})
stickers.add({name:'Source sample sticker',keywords:'sample,generic',scenes:['happy'],dataUrl:part.image_url.url})
const cache=createImageCache({dir:path.join(dir,'image-cache'),logger})
const image=await cache.load({file:'sample.png'},async()=>part)
await cache.describe([image.hash],'sample',async()=>'Generic image description')
const summary=createDailySummary({config,logger,onebot:{selfId:'789',call(){throw Error('no QQ in fixture')}}})
summary.capture({message_type:'group',group_id:123,user_id:456,message_id:1,time:1,sender:{nickname:'Sample'}},
  {text:'Source daily record',replyId:'',atBot:false})
summary.stop()
long.stop()
memory.flush()
console.log('offline fixture written')
