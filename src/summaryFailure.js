/** 给群友解释真实失败原因，不把接口拒绝误报成可稍后重试的故障。 */
export function summaryFailureMessage(error, stage = 'model') {
  if (stage === 'send') return '群总结已经生成，但 QQ 发送失败了。请检查机器人是否在线，以及群聊发送权限。'
  if (error?.code === 'SUMMARY_DEADLINE') return '这次群总结准备时间超过上限，已取消本群任务，其他群继续。请稍后重试，或在控制台调整单群准备时限。'
  if (error?.code === 'REPORT_INCOMPLETE') return '这次模型没有写齐群总结的必要小节或条目，自动修正一次后仍不完整，所以暂未发送残缺报告。请稍后重试，具体原因可查看控制台日志。'
  const text = `${error?.code || ''} ${error?.message || ''}`
  if (/DataInspectionFailed|data_inspection_failed|content_filter|content_policy_violation/i.test(text)) {
    return '这次群总结被模型服务的内容检查拦截了，暂时无法生成。增加等待时间或 token 上限无法解决，请查看控制台日志了解原因。'
  }
  if (error?.code === 'OUTPUT_LIMIT') return '这次群总结达到了模型的输出 token 上限，内容尚未写完。请在控制台提高总结输出上限，或缩短总结时间范围后重试。'
  if (/context_length_exceeded|maximum context length|input.*token.*exceed/i.test(text)) return '这次总结的聊天记录超过了模型输入容量。请缩短总结时间范围后重试。'
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /ETIMEDOUT|UND_ERR_.*TIMEOUT|请求超时/i.test(text + ' ' + (error?.cause?.code || ''))) {
    return '这次群总结等待模型响应超时了，请稍后重试。'
  }
  if (error?.status === 401 || error?.status === 403) return '总结模型接口未通过身份或权限验证，请检查控制台中的模型密钥和权限。'
  if (error?.status === 402 || /insufficient_quota|余额不足/i.test(text)) return '总结模型账户的余额或额度不足，请检查模型账户。'
  if (error?.status === 429) return '总结模型请求过于频繁，重试后仍未成功，请稍后再试。'
  if (error?.status === 400) return '总结模型拒绝了这次请求，请查看控制台日志中的具体原因。'
  return '这次群总结生成失败了，请查看控制台日志中的具体原因后再试。'
}
