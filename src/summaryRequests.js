/** 总任务可以无限等待；每次模型调用仍须能超时并交给有限重试恢复。 */
export function summaryRequestTimeout(config, fallbackMs) {
  if (!config.summaryUnrestricted) return fallbackMs
  const seconds = Number(config.summaryRequestTimeoutSeconds ?? 900)
  return Math.max(60, Math.min(3600, Number.isFinite(seconds) ? seconds : 900)) * 1000
}
