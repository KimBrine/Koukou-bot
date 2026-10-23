/** 普通文字回复之后的一次配图机会；模型选图也不能绕过概率或范围。 */
export const claimsStickerDelivery = text => /(?:表情包|图片|图).{0,12}(?:来[啦了咯]|发[出送给]|拿去|收好)|(?:发[出送给]|给你发|拿去|收好).{0,12}(?:图|表情包)/u.test(String(text || ''))

/**
 * 用户在"要图"（确定性判断，不依赖模型自觉打 [索要表情包] 标记）。
 * 只认带请求动词的短句，避免"这个图好看"这类描述误判。
 */
export const userAsksForSticker = text => /(?:给我|帮我|请|麻烦|来|发|整|要|换).{0,10}(?:表情包|贴纸|表情|图片|图)/u.test(String(text || ''))
export function createStickerSendPolicy({config,stickers,rand=Math.random,now=Date.now}) {
  const last=new Map()
  const chatKey=e=>e.message_type==='private'?`p${e.user_id}`:`g${e.group_id}`
  const library=e=>stickers?.forChat?.(chatKey(e)) || stickers
  const cooldownKey=e=>`${stickers?.scope?.(chatKey(e))?.key||''}:${chatKey(e)}`
  function allowed(e, store=library(e)){
    if(!config.stickersEnabled||!store?.count())return false
    const scope=config.stickerSendScope||'all',privateChat=e.message_type==='private'
    return scope==='private'?privateChat:scope==='whitelist'?!privateChat&&config.whitelistGroups?.has(Number(e.group_id)):
      scope==='selected'?!privateChat&&config.stickerSendGroups?.has(Number(e.group_id)):scope==='all'
  }
  function select(e,{text,queries=[],context='',requested=false,store=library(e)}){
    const key=cooldownKey(e)
    const rate=Math.min(1,Math.max(0,config.stickerAutoRate??.35))
    if(!String(text||'').trim())return {items:[],reason:'没有已发送文字'}
    if(!allowed(e,store))return {items:[],reason:'开关或发送范围限制'}
    if(now()-(last.get(key)??-Infinity)<(config.stickerCooldownSeconds||0)*1000)return {items:[],reason:'会话配图冷却'}
    if(!requested&&(rate<=0||rand()>=rate))return {items:[],reason:'未命中配图概率'}
    const limit=Math.max(1,Math.min(3,config.stickerMaxPerReply||1)),mode=config.stickerPickMode||'context'
    let source=mode==='random'?'用户配置随机模式':'模型候选按匹配程度加权抽取'
    let items=mode==='random'?[]:store.choose?store.choose(queries,{limit,rand}):queries.map(q=>store.find(q)).filter(Boolean)
    // 普通配图只对模型候选做模糊加权匹配，不另用整段历史或全库随机补选。
    // 明确索图仍可按语境/随机兜底，用户主动选择随机模式也保留原行为。
    if(!items.length&&(mode==='random'||requested)){
      const item=mode==='random'?store.random():store.pick(context+' '+text)
      source=mode==='random'?source:'明确索图的语境/随机候选'
      if(item)items=[item]
    }
    items=[...new Map(items.map(i=>[i.id,i])).values()].slice(0,limit)
    return {items,source,reason:items.length?(requested?'明确索图请求':'文字配图'):'模型没有选中合适的库内图片，不补图'}
  }
  function begin(e){const key=cooldownKey(e);last.set(key,now());if(last.size>1000)last.delete(last.keys().next().value)}
  return {allowed,select,begin}
}
