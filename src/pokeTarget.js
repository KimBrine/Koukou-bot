const valid = id => /^\d{1,15}$/.test(String(id)) && Number.isSafeInteger(Number(id)) && Number(id)>0
const norm = s => String(s || '').normalize('NFKC').replace(/\s+/gu,'').toLowerCase()
export function pokeMentions(message, selfId) {
  const ids=Array.isArray(message)?message.filter(s=>s?.type==='at').map(s=>s.data?.qq):[...String(message||'').matchAll(/\[CQ:at,qq=(\d+)(?:,|\])/g)].map(m=>m[1])
  return [...new Set(ids.filter(id=>valid(id)&&String(id)!==String(selfId)).map(String))]
}
export function pokeQuote(event, raw, replyId) {
  const id=raw?.user_id??raw?.sender?.user_id
  return raw&&raw.message_type!=='private'&&String(raw.group_id)===String(event.group_id)&&String(raw.message_id)===String(replyId)&&valid(id)?{userId:String(id),name:String(raw.sender?.card||raw.sender?.nickname||id),messageId:String(replyId)}:null
}
/** 低影响拍一拍：允许近期指代，但所有号码必须来自当前请求或真实上下文。 */
export async function resolvePokeTarget({event,text,parsed,result,quote,recent,onebot}) {
  const target=result.target&&typeof result.target==='object'?result.target:{}
  const ats=pokeMentions(event.message??event.raw_message,onebot.selfId)
  if(ats.length>1)return null
  if(ats.length===1)return ats[0]
  const source=String(result.selfSource||target.source||'')
  if((result.intent==='poke_self'||target.type==='self')&&/^(?:我|我自己|自己|本人|我本人|本宝宝|本喵)$/.test(source)&&text.includes(source)&&!/拍(?:一拍|拍|一下)?(?:他|她|这位|那位)/.test(text))return String(event.user_id)
  const value=String(target.value??'')
  if(target.type==='qq'&&valid(value)&&new RegExp(`(^|[^0-9])${value}([^0-9]|$)`).test(text))return value
  if(target.type==='name'&&norm(value)&&text.includes(value)) {
    const raw=await onebot.getGroupMemberList(event.group_id,8000)
    const members=raw?.data??raw
    if(!Array.isArray(members))return null
    const exact=members.filter(m=>[m.card,m.nickname].some(n=>norm(n)===norm(value)))
    const match=exact.length?exact:members.filter(m=>[m.card,m.nickname].some(n=>norm(n)&&norm(n).includes(norm(value))))
    return match.length===1&&valid(match[0].user_id)?String(match[0].user_id):null
  }
  if(quote)return quote.userId
  if(parsed.replyId&&target.type==='reply')return null
  // 模型只可从实际近期作者、被提及者和已核对引用人中选择，不能凭空提供号码。
  const candidates=new Set(recent.flatMap(m=>[m.userId,...(m.mentionedIds||[]),m.replyAuthor]).filter(valid).map(String))
  if(target.type==='context'&&candidates.has(value))return value
  // “他/这位”没有解析出号码时，先看申请人最近一次指向的成员，再看最近发言者。
  if(/他|她|这位|那位|这个|那个|刚才|刚刚|上面/.test(text)) {
    const own=[...recent].reverse().find(m=>String(m.userId)===String(event.user_id)&&((m.mentionedIds||[]).length||m.replyAuthor))
    const pointed=own?.replyAuthor?[own.replyAuthor]:own?.mentionedIds||[]
    if(pointed.length===1)return String(pointed[0])
    const last=[...recent].reverse().find(m=>valid(m.userId)&&String(m.userId)!==String(event.user_id)&&String(m.userId)!==String(onebot.selfId))
    if(last)return String(last.userId)
  }
  return null
}
