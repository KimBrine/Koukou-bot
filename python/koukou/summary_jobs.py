"""Per-report preparation deadlines and conservative outgoing receipt classification."""
import asyncio
import re
import time


class SummarySendUncertain(RuntimeError):
    code = 'SUMMARY_SEND_UNCERTAIN'
    outcome_unknown = True


class SummaryDeadlineExceeded(TimeoutError):
    code = 'SUMMARY_DEADLINE'


def ambiguous_send(error):
    return isinstance(error, (asyncio.CancelledError, TimeoutError)) or getattr(error, 'outcome_unknown', False) or getattr(error, 'code', '') == 'SUMMARY_SEND_UNCERTAIN' or bool(re.search(r'超时|timeout|连接.*(?:中断|断开)|WebSocket|socket|ECONNRESET', str(error), re.I))


def receipt_id(result):
    value = str(result.get('message_id', '')) if isinstance(result, dict) else ''
    if not re.fullmatch(r'-?\d+', value) or int(value) == 0:
        raise SummarySendUncertain('QQ 未返回有效的报告消息编号，发送结果待历史核验')
    return value


class SummaryDeadline:
    def __init__(self, config):
        self.minutes = max(2, min(30, config.number('SUMMARY_TASK_TIMEOUT_MINUTES', 6)))
        self.deadline = None if config.enabled('SUMMARY_UNRESTRICTED', True) else time.monotonic()+self.minutes*60

    async def wait(self, awaitable):
        if self.deadline is None:
            return await awaitable
        timer = asyncio.timeout(max(.001, self.deadline-time.monotonic()))
        try:
            async with timer:
                return await awaitable
        except TimeoutError as error:
            if not timer.expired():
                raise
            raise SummaryDeadlineExceeded(f'群总结准备超过 {self.minutes:g} 分钟，已取消本群任务') from error
