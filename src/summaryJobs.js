/** 生成并行、发送串行；各群的超时与失败互不占用后续生成位置。 */
export const summaryConcurrency = config => Math.max(1, Math.min(3, Math.floor(Number(config.summaryConcurrency) || 2)))

export function createSummaryDeadline(config) {
  const minutes = Math.max(2, Math.min(30, Number(config.summaryTaskTimeoutMinutes) || 6))
  const controller = new AbortController()
  const error = new Error(`群总结准备超过 ${minutes} 分钟，已取消本群任务`)
  error.name = 'TimeoutError'
  error.code = 'SUMMARY_DEADLINE'
  const timer = setTimeout(() => controller.abort(error), minutes * 60000)
  timer.unref?.()
  const signal = controller.signal
  return {
    signal,
    close: () => clearTimeout(timer),
    async wait(promise) {
      signal.throwIfAborted()
      let aborted
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          aborted = () => reject(signal.reason)
          signal.addEventListener('abort', aborted, { once: true })
        })])
      } finally { signal.removeEventListener('abort', aborted) }
    },
  }
}

export function createSummarySendQueue({ pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  let tail = Promise.resolve(), lastFinished = null
  return task => {
    const work = tail.then(async () => {
      if (lastFinished !== null) await pause(Math.max(0, 5000 - (now() - lastFinished)))
      try { return await task() } finally { lastFinished = now() }
    })
    // 失败只传回当前群，下一群仍能进入发送队列。
    tail = work.catch(() => {})
    return work
  }
}
