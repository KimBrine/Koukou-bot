"""China-time scheduling, durable pre-send intents, and absence-only evening recovery."""
import asyncio
from datetime import datetime, timedelta
import logging
import math
import re
import time
from .forward_records import CHINA, get_forward, node_list
from .messages import parse_message, segments
from .state import read_json, write_json
from .summary_jobs import SummaryDeadline, SummarySendUncertain, ambiguous_send, receipt_id


def china_date(at):
    return datetime.fromtimestamp(at, CHINA)


def china_day(at):
    return china_date(at).strftime('%Y-%m-%d')


def target_at(day, clock):
    return datetime.fromisoformat(day+'T'+clock+':00+08:00').timestamp()


class SummarySchedule:
    def __init__(self, config, onebot, groups, run_group, is_running, read_history, *, now=time.time, pause=asyncio.sleep):
        self.config, self.onebot, self.groups, self.run_group = config, onebot, groups, run_group
        self.is_running, self.read_history, self.now, self.pause = is_running, read_history, now, pause
        self.file = config.data_dir / 'summary-delivery-state.json'
        self.log = logging.getLogger('koukou.summary.schedule')
        self.state_uncertain = False
        try:
            self.state = read_json(self.file, {'version': 1, 'deliveries': {}, 'slots': {}})
            if not isinstance(self.state, dict) or self.state.get('version') != 1 or not all(isinstance(self.state.get(k), dict) for k in ['deliveries', 'slots']) or any(not isinstance(v, dict) for k in ['deliveries', 'slots'] for v in self.state[k].values()):
                raise ValueError('记录格式不正确')
            for key, entry in self.state['deliveries'].items():
                confirmed = entry.get('confirmed', 0)
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}:\d+', key) or isinstance(confirmed, bool) or not isinstance(confirmed, (int, float)) or not math.isfinite(confirmed) or confirmed < 0 or int(confirmed) != confirmed:
                    raise ValueError('发送回执计数不正确')
                if not isinstance(entry.get('receiptIds', []), list) or any(not re.fullmatch(r'-?\d+', str(value)) or int(value) == 0 for value in entry.get('receiptIds', [])):
                    raise ValueError('发送回执编号不正确')
            self.state_uncertain = bool(self.state.get('uncertainState'))
        except (ValueError, OSError, TypeError):
            self.state = {'version': 1, 'deliveries': {}, 'slots': {}, 'uncertainState': True}
            self.state_uncertain = True
        self.tasks, self.planned, self.checked = set(), set(), set()
        self.started, self.manual_in_progress = False, False

    def enabled(self):
        return self.config.enabled('SUMMARY_FALLBACK_ENABLED', False)

    def configured_times(self):
        clocks = []
        for value in re.split(r'[,，\s]+', self.config.get('SUMMARY_TIMES', '23:00')):
            if re.fullmatch(r'([01]?\d|2[0-3]):[0-5]\d', value):
                hh, mm = value.split(':'); clock = f'{int(hh):02d}:{mm}'
                if clock not in clocks:
                    clocks.append(clock)
        return clocks

    def save(self):
        cutoff = china_day(self.now()-14*86400)
        for name in ['deliveries', 'slots']:
            self.state[name] = {k: v for k, v in self.state[name].items() if k[:10] >= cutoff}
        write_json(self.file, self.state)

    def key(self, day, group):
        return day+':'+str(int(group))

    def has_delivered(self, day, group):
        entry = self.state['deliveries'].get(self.key(day, group), {})
        return entry.get('account', str(self.onebot.self_id)) == str(self.onebot.self_id) and float(entry.get('confirmed') or 0) > 0

    def before_send(self, group):
        if not self.enabled() or china_date(self.now()).hour < 23:
            return None
        key = self.key(china_day(self.now()), group)
        entry = self.state['deliveries'].setdefault(key, {'confirmed': 0, 'receiptIds': []})
        if entry.get('account', str(self.onebot.self_id)) != str(self.onebot.self_id):
            entry = {'confirmed': 0, 'receiptIds': []}; self.state['deliveries'][key] = entry
        entry.update(attemptedAt=self.now()*1000, pending=True, account=str(self.onebot.self_id))
        try:
            self.save()
        except Exception as error:
            raise SummarySendUncertain('报告发送意图保存失败') from error
        return key

    def acknowledged(self, key, result):
        message_id = receipt_id(result)
        if key is None:
            return
        entry = self.state['deliveries'][key]
        entry.update(confirmed=int(entry.get('confirmed') or 0)+1, receiptIds=list(dict.fromkeys([*entry.get('receiptIds', []), message_id]))[-100:], pending=False, sentAt=self.now()*1000)
        try:
            self.save()
        except Exception as error:
            raise SummarySendUncertain('报告回执保存失败') from error

    def failed(self, key, error):
        if key is None:
            return
        self.state['deliveries'][key].update(pending=False, uncertain=ambiguous_send(error))
        try:
            self.save()
        except Exception:
            self.log.warning('未确认的总结发送记录保存失败')

    async def check_online(self):
        for attempt in range(3):
            try:
                refresh = getattr(self.onebot, 'refresh_status', None)
                health = await refresh() if refresh else {}
                if health.get('online') is True and health.get('connected') is True:
                    return {'online': True, 'offline': False}
                if health.get('connected') is False or health.get('qqOnline') is False or health.get('reportedOnline') is False:
                    return {'online': False, 'offline': True}
            except Exception:
                pass
            if attempt < 2:
                await self.pause(.7)
        return {'online': False, 'offline': False}

    async def online(self):
        return (await self.check_online())['online']

    async def inspect_content(self, raw, day, depth=0, seen=None):
        if depth > 6 or not isinstance(raw, (str, list)) or isinstance(raw, list) and not raw:
            return 'unknown'
        seen = set() if seen is None else seen
        parsed = parse_message(raw)
        formatted_day = re.sub(r'^(\d{4})-(\d{2})-(\d{2})$', r'\1年\2月\3日', day)
        if '群聊日常分析报告' in parsed.text and (formatted_day in parsed.text or day in parsed.text):
            return 'sent'
        uncertain = bool(re.search(r'📊\s*基础统计|💬\s*热门话题|🏆\s*群友称号|💬\s*群圣经', parsed.text))
        uncertain |= any(s.get('type') in {'json', 'xml', 'markdown', 'node'} for s in segments(raw) if isinstance(s, dict))
        for segment in parsed.forwards:
            if segment.get('type') == 'node':
                uncertain = True; continue
            data = segment.get('data') or {}
            nodes = data.get('content')
            if not isinstance(nodes, list):
                card_id = str(data.get('id') or '')
                if not card_id or card_id in seen:
                    uncertain = True; continue
                seen.add(card_id)
                try:
                    nodes = node_list(await get_forward(self.onebot, card_id, 15))
                except Exception:
                    uncertain = True; continue
            if not nodes:
                uncertain = True; continue
            for node in nodes:
                if not isinstance(node, dict):
                    uncertain = True; continue
                data = node.get('data') if node.get('type') == 'node' else node
                data = data if isinstance(data, dict) else {}
                result = await self.inspect_content(data.get('message', data.get('content')), day, depth+1, seen)
                if result == 'sent':
                    return result
                uncertain |= result == 'unknown'
        return 'unknown' if uncertain else 'absent'

    async def verify_not_sent(self, group, day):
        if self.has_delivered(day, group) or not self.onebot.self_id:
            return False
        account = str(self.onebot.self_id)
        start = target_at(day, '23:00')-15
        try:
            history = await self.read_history(group, start)
            if account != str(self.onebot.self_id) or not isinstance(history.get('rawMessages'), list):
                return False
            uncertain = False
            for message in history['rawMessages']:
                if str(message.get('user_id')) != account or float(message.get('time') or 0) < start:
                    continue
                result = await self.inspect_content(message.get('message', message.get('raw_message')), day)
                if account != str(self.onebot.self_id):
                    return False
                if result == 'sent':
                    self.state['deliveries'][self.key(day, group)] = {'confirmed': 1, 'receiptIds': [str(message.get('message_id', ''))], 'sentAt': float(message['time'])*1000, 'verifiedFromHistory': True, 'account': account}
                    self.save(); return False
                uncertain |= result == 'unknown'
            entry = self.state['deliveries'].get(self.key(day, group), {})
            return bool(history.get('complete')) and not uncertain and not self.state_uncertain and not entry.get('pending') and not entry.get('uncertain')
        except Exception:
            return False

    async def run_slot(self, clock, day=None, *, early_fallback=False, group_ids=None, stats_only=False):
        day = day or china_day(self.now())
        if early_fallback and self.manual_in_progress:
            return
        if early_fallback:
            self.manual_in_progress = True
        try:
            return await self._execute(clock, day, early_fallback, group_ids, stats_only)
        finally:
            if early_fallback:
                self.manual_in_progress = False

    async def _execute(self, clock, day, early, group_ids, stats_only):
        if not self.config.enabled('SUMMARY_ENABLED') or china_day(self.now()) != day:
            return
        fallback = self.enabled() and clock == '23:30'
        if fallback and '23:00' not in self.configured_times():
            return
        slot = day+':'+clock
        if (slot in self.checked or self.state['slots'].get(slot)) and not early:
            return
        self.checked.add(slot)
        if self.enabled():
            self.state['slots'][slot] = {'checkedAt': self.now()*1000}; self.save()
        if not await self.online():
            return
        targets = list(dict.fromkeys(map(int, self.groups())))
        if group_ids is not None:
            targets = [g for g in targets if g in set(map(int, group_ids))]
        if not fallback:
            self.planned.update(self.key(day, g) for g in targets)
        cursor, stopped = 0, False
        async def worker():
            nonlocal cursor, stopped
            while not stopped and cursor < len(targets):
                group = targets[cursor]; cursor += 1; key = self.key(day, group)
                try:
                    if self.enabled() and (self.has_delivered(day, group) or fallback and key in self.planned) or self.is_running(group):
                        continue
                    if fallback and not await SummaryDeadline(self.config).wait(self.verify_not_sent(group, day)):
                        continue
                    if self.has_delivered(day, group):
                        continue
                    if china_day(self.now()) != day:
                        stopped = True; break
                    health = await self.check_online()
                    if not health['online']:
                        stopped = health['offline']; continue
                    await self.run_group(group, scheduled=True, schedule_day=day, schedule_time=clock, statistics=stats_only)
                    if cursor < len(targets):
                        await self.pause(5)
                except Exception as error:
                    self.log.warning('群 %s 定时总结失败，继续其他群：%s', group, type(error).__name__)
                finally:
                    if not fallback:
                        self.planned.discard(key)
        try:
            await asyncio.gather(*(worker() for _ in range(min(len(targets), max(1, min(3, int(self.config.number('SUMMARY_CONCURRENCY', 2))))))))
        finally:
            if not fallback:
                for group in targets:
                    self.planned.discard(self.key(day, group))

    def track(self, task):
        self.tasks.add(task)
        def done(task):
            self.tasks.discard(task)
            if not task.cancelled() and task.exception():
                self.log.warning('定时总结检查失败：%s', type(task.exception()).__name__)
        task.add_done_callback(done)

    def start(self):
        if self.started or not self.config.enabled('SUMMARY_ENABLED'):
            return
        self.started = True
        clocks = self.configured_times()
        if self.enabled() and '23:00' in clocks and '23:30' not in clocks:
            clocks.append('23:30')
        for clock in clocks:
            self.track(asyncio.create_task(self._arm(clock)))

    async def _arm(self, clock):
        while self.started:
            day = china_day(self.now()); target = target_at(day, clock)
            if target <= self.now():
                target += 86400
            day = china_day(target)
            while self.started and self.now() < target:
                await self.pause(min(60, max(.01, target-self.now())))
            if not self.started:
                return
            if china_day(self.now()) == day and self.now()-target < 60:
                self.track(asyncio.create_task(self.run_slot(clock, day)))

    async def close(self):
        self.started = False
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
