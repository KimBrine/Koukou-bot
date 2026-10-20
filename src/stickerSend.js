/** 普通文字回复之后的一次配图机会；模型选图也不能绕过概率或范围。 */
export const claimsStickerDelivery = text => /(?:表情包|图片|图).{0,12}(?:来[啦了咯]|发[出送给]|拿去|收好)|(?:发[出送给]|给你发|拿去|收好).{0,12}(?:图|表情包)/u.test(String(text || ''))
export function createStickerSendPolicy({config,stickers,rand=Math.random,now=Date.now}) {
  const last=new Map()
  function allowed(e){
    if(!config.stickersEnabled||!stickers?.count())return false
    const scope=config.stickerSendScope||'all',privateChat=e.message_type==='private'
    return scope==='private'?privateChat:scope==='whitelist'?!privateChat&&config.whitelistGroups?.has(Number(e.group_id)):
      scope==='selected'?!privateChat&&config.stickerSendGroups?.has(Number(e.group_id)):scope==='all'
  }
  function select(e,{text,queries=[],context='',requested=false}){
    const key=e.message_type==='private'?`p${e.user_id}`:`g${e.group_id}`
    const rate=Math.min(1,Math.max(0,config.stickerAutoRate??.35))
    if(!String(text||'').trim())return {items:[],reason:'没有已发送文字'}
    if(!allowed(e))return {items:[],reason:'开关或发送范围限制'}
    if(now()-(last.get(key)??-Infinity)<(config.stickerCooldownSeconds||0)*1000)return {items:[],reason:'会话配图冷却'}
    if(!requested&&(rate<=0||rand()>=rate))return {items:[],reason:'未命中配图概率'}
    const limit=Math.max(1,Math.min(3,config.stickerMaxPerReply||1)),mode=config.stickerPickMode||'context'
    let items=mode==='random'?[]:queries.map(q=>stickers.find(q)).filter(Boolean)
    if(!items.length&&(mode!=='model'||requested)){
      const item=mode==='random'?stickers.random():stickers.pick(context+' '+text)
      if(item)items=[item]
    }
    items=[...new Map(items.map(i=>[i.id,i])).values()].slice(0,limit)
    return {items,reason:items.length?(requested?'明确索图请求':'文字配图'):'没有合适的选图结果'}
  }
  function begin(e){const key=e.message_type==='private'?`p${e.user_id}`:`g${e.group_id}`;last.set(key,now());if(last.size>1000)last.delete(last.keys().next().value)}
  return {allowed,select,begin}
}
