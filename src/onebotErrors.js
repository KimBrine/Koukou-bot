export function onebotError(message,{code='ONEBOT_API_FAILED',action='',outcomeUnknown=false}={}){
  return Object.assign(new Error(message),{code,action,service:'onebot',outcomeUnknown})
}
export const isOnebotError=error=>error?.service==='onebot'||/^ONEBOT_/.test(error?.code||'')||/OneBot|连接已断开/.test(String(error?.message||error||''))
export function healthAlertForError(text){
  text=String(text).replace(/\s+/g,' ')
  if(/OneBot|QQ 消息发送失败/.test(text))return {key:'qq-delivery',text:'QQ 接口异常：'+text.slice(0,180)+(/send_\w*msg|消息发送失败/.test(text)?'。发送超时表示结果未确认，请先核对群内消息，不要直接重复发送。':'。请检查 QQ 登录和接口连接状态。')}
  if(/余额|额度|quota|429|401|403|请求参数错误|超时|timeout|ECONN|socket hang up/i.test(text))return {key:'model-health',text:'模型调用可能异常：'+text.slice(0,180)}
  return null
}
