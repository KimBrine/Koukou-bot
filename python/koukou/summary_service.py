"""Native report jobs; explicit completeness, persistent receipts and per-group progress."""
import asyncio
from datetime import timedelta
import json
import re
import time
from pathlib import Path
from .messages import quiet_hour
from .sessions import digest
from .state import read_json, write_json
from .summary_basics import SummaryProgress, content_profile, parse_summary_format, summary_stats
from .summary_history import SummaryHistory, DailyArchive, merge_records
from .summary_quality import generate_checked
from .summary_content import format_content_guide, render_lines, select_records
from .summary_names import build_name_index, replace_topic_references, resolve_summary_names
from .summary_references import prepare_references
from .summary_jobs import SummaryDeadline, SummarySendUncertain, ambiguous_send, receipt_id
from .summary_schedule import SummarySchedule, china_date, china_day

PROMPT = json.loads(Path(__file__).with_name('summary_prompt.json').read_text(encoding='utf-8'))['text']


def stats_block(stats):
    return '\n'.join(['📊 基础统计', f"• 消息总数: {stats['total']}", f"• 参与人数: {stats['people']}", f"• 总字符数: {stats['chars']}", f"• 表情数量: {stats['emoji']}", f"• 最活跃时段: {stats['peak']}"])


def report_date(start, end):
    fmt = lambda value: re.sub(r'^(\d{4})-(\d{2})-(\d{2})$', r'\1年\2月\3日', value)
    return fmt(start) if start == end else fmt(start)+' ~ '+fmt(end)


def replace_names(blocks, records):
    return replace_topic_references(blocks, build_name_index(records=records))


def report_blocks(start, end, stats, text, records, statistics=False, name_index=None):
    title = '🎯 群聊日常分析报告'+('（统计版）' if statistics else '')+'\n📅 '+report_date(start, end)
    return [title, stats_block(stats), *replace_topic_references(parse_summary_format(text)['blocks'], name_index if name_index is not None else build_name_index(records=records))]


def build_prompt(config, days, label, stats, profile):
    limit = len(stats['users']) if config.enabled('SUMMARY_UNRESTRICTED', True) else max(3, min(50, int(config.number('SUMMARY_USER_ROWS', 20))))
    user_table = '\n'.join(f"- {u['name']}（QQ {u['userId']}）：发言 {u['count']} 条｜平均 {u['avgChars']:g} 字｜表情占比 {u['emojiRatio']:g}｜回复比例 {u['replyRatio']:g}" for u in stats['users'][:limit])
    guide = format_content_guide(profile)
    values = {'botName': config.get('BOT_NAME', 'Koukou'), 'dateLabel': label, 'userTable': user_table, 'contentGuide': guide, 'scope': '今天' if days == 1 else f'最近 {days} 天', **stats}
    return re.sub(r'\{\{(\w+)\}\}', lambda match: str(values[match[1]]), PROMPT)


class SummaryService:
    def __init__(self, config, onebot, model, memory, settings, *, now=time.time, pause=asyncio.sleep, vision_model=None, image_cache=None, load_image=None):
        self.config, self.onebot, self.model, self.memory, self.settings = config, onebot, model, memory, settings
        self.now, self.pause = now, pause
        self.vision_model, self.image_cache, self.load_image = vision_model, image_cache, load_image
        self.archive = DailyArchive(config, onebot)
        self.history = SummaryHistory(onebot, unrestricted=config.enabled('SUMMARY_UNRESTRICTED', True), pause=pause)
        self.progress = SummaryProgress(config.data_dir / 'summary-progress.json')
        self.running, self.tasks = set(), set()
        self.generate_lock = asyncio.Semaphore(max(1, min(3, int(config.number('SUMMARY_CONCURRENCY', 2)))))
        self.send_lock = asyncio.Lock()
        self.receipts_file = config.data_dir / 'native-summary-receipts.json'
        self.receipts = read_json(self.receipts_file, {})
        if not isinstance(self.receipts, dict):
            raise ValueError('群总结发送记录损坏')
        self.stopped = False
        self.last_send_finished = None
        self.schedule = SummarySchedule(config, onebot, self.groups, self.run_scheduled, lambda group: group in self.running,
                                        self.read_evening_history, now=now, pause=pause)

    def start(self):
        self.schedule.start()

    async def read_evening_history(self, group, start):
        return await self.history.backfill(group, start, int(self.now()), count=300, include_self=True)

    async def run_scheduled(self, group, *, scheduled=True, schedule_day='', schedule_time='', statistics=False):
        if group in self.running or self.stopped:
            return
        self.running.add(group)
        job = self.progress.start(group, scheduled=True)
        return await self.run(group, job, statistics=statistics, scheduled=scheduled, schedule_day=schedule_day, schedule_time=schedule_time)

    def can_publish(self, group):
        key = 'g'+str(group); settings = self.settings.get(key, {})
        spec = settings.get('quietHours') if settings.get('quietHours') is not None else self.config.get('QUIET_HOURS')
        return not self.stopped and settings.get('enabled') is not False and int(group) not in self.config.ids('MUTED_GROUPS') and not quiet_hour(spec, china_date(self.now())) and self.onebot.status().get('online', False)

    def groups(self):
        return sorted(self.config.ids('SUMMARY_GROUPS') or self.config.ids('WHITELIST_GROUPS'))

    def trigger(self, groups=None, days=1, dry_run=False, statistics=False):
        if self.stopped:
            raise ValueError('群总结服务已关闭')
        groups = self.groups() if groups is None else list(groups)
        busy = []
        for group in groups:
            if not str(group).isdecimal() or not 0 < int(group) <= 9007199254740991:
                raise ValueError('群号无效')
            group = int(group)
            if group in self.running:
                busy.append(group); continue
            self.running.add(group)
            job = self.progress.start(group, days=max(1, min(30, int(days))))
            task = asyncio.create_task(self.run(group, job, dry_run, statistics))
            self.tasks.add(task); task.add_done_callback(self.tasks.discard)
        return {'ok': True, 'groups': groups, 'busy': busy, 'progress': list(self.progress.items.values())}

    async def wait(self):
        await asyncio.gather(*list(self.tasks))

    async def close(self):
        self.stopped = True
        await self.schedule.close()
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)

    async def run(self, group, job, dry_run=False, statistics=False, *, scheduled=False, schedule_day='', schedule_time=''):
        id, key, account = job['jobId'], 'g'+str(group), self.onebot.self_id
        persona = None
        revision = getattr(self.config, 'persona_revision', 0)
        account_version = getattr(self.onebot, 'account_version', 0)
        boundary = self.memory.version(key)
        def active():
            return not self.stopped and self.onebot.self_id == account and getattr(self.onebot, 'account_version', 0) == account_version and getattr(self.config, 'persona_revision', 0) == revision and self.memory.version(key) == boundary and digest(self.config.persona(self.settings.get(key, {}).get('persona', ''))) == digest(persona)
        def update(stage, message, status='generating', **extra):
            return self.progress.update(group, id, stage=stage, message=message, status=status, **extra)
        try:
            persona = self.config.persona(self.settings.get(key, {}).get('persona', ''))
            if not dry_run and any(v.get('groupId') == group and v.get('status') in {'reserved', 'uncertain'} and str(token).startswith(str(account)+':') for token, v in self.receipts.items()):
                raise ValueError('本群存在发送结果不明的报告，请先核对QQ；未重复生成或发送')
            async with self.generate_lock:
                deadline = SummaryDeadline(self.config)
                end = int(self.now()); end_date = china_date(end)
                start_date = end_date.replace(hour=0, minute=0, second=0, microsecond=0)-timedelta(days=job['days']-1)
                start = int(start_date.timestamp()); start_key, end_key = start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d')
                captured = self.archive.read(group, [(start_date+timedelta(days=i)).strftime('%Y-%m-%d') for i in range(job['days'])])
                history = await deadline.wait(self.history.backfill(group, start, end, count=job['days']*300))
                if not history['complete']:
                    update('history', '历史记录未确认完整，本次没有发布报告。', 'failed'); return
                records = merge_records(history['records'], captured, start, end)
                if not records:
                    update('empty', '这段时间没有可总结的消息，未发送报告。', 'failed'); return
                stats = summary_stats(records); profile = content_profile(records, self.config.ids('SUMMARY_BOT_USERS'))
                profile['unrestricted'] = self.config.enabled('SUMMARY_UNRESTRICTED', True)
                name_index = build_name_index(users=stats['users'], records=records)
                source_records = records
                if not profile['unrestricted']:
                    records = select_records(records, min(1500, max(50, min(2000, int(self.config.number('SUMMARY_MAX_MESSAGES', 600))))*job['days']), self.config.ids('SUMMARY_BOT_USERS'))
                if not active():
                    raise ValueError('人格、记忆边界或账号已变化')
                update('model', f"已核对完整历史，共{len(records)}条，正在生成正文")
                degraded = statistics
                if statistics:
                    text = 'ℹ️ 统计版说明\n本次按要求生成统计版，未调用模型。未生成热门话题、群友称号或原话点评；不代表今天没有讨论。'
                else:
                    if not self.model:
                        raise ValueError('总结模型未配置')
                    transcript = render_lines(records, job['days'], profile['unrestricted'])
                    prompt = build_prompt(self.config, job['days'], start_key if start_key == end_key else start_key+' ~ '+end_key, stats, profile)
                    try:
                        update('references', f"已读取 {len(source_records)} 条消息，正在整理相关聊天记录及图片")
                        references = await deadline.wait(prepare_references(source_records, self.onebot, vision_model=self.vision_model,
                            image_cache=self.image_cache, load_image=self.load_image, main_chars=len(transcript),
                            max_images=max(0, min(12, int(self.config.number('SUMMARY_REFERENCE_MAX_IMAGES', 6)))), unrestricted=profile['unrestricted']))
                        if references['text']:
                            transcript += '\n\n'+references['text']
                        update('model', f"已读取 {len(source_records)} 条消息，正在生成和检查总结正文")
                        text = await deadline.wait(generate_checked(self.model, prompt, [{'role':'user','content':transcript}], records, stats, profile, pause=self.pause))
                    except Exception as error:
                        if not re.search('DataInspectionFailed|data_inspection_failed|content_filter|content_policy_violation', str(error), re.I):
                            raise
                        degraded = True
                        text = 'ℹ️ 统计版说明\n总结模型的内容检查未通过，本次无法生成正文。\n本报告仅包含程序核验的消息统计，未生成热门话题、群友称号或原话点评；不代表今天没有讨论。'
                if not active():
                    raise ValueError('生成期间人格或记忆边界变化，未发送旧报告')
                if not degraded:
                    update('format', '正在核对昵称和排版')
                    await deadline.wait(resolve_summary_names(text, name_index, self.onebot, group))
                blocks = report_blocks(start_key, end_key, stats, text, source_records, degraded, name_index)
                if dry_run:
                    update('preview', '预览生成完成，未向群聊发送。', 'success', resultKind='statistics' if degraded else 'full'); return blocks
            update('queued', '正文已生成，等待本群可发送时段')
            slept_before_send = not self.can_publish(group)
            while not self.can_publish(group):
                if not active():
                    raise ValueError('等待发送期间任务已失效')
                await self.pause(5)
            async with self.send_lock:
                if self.last_send_finished is not None:
                    await self.pause(max(0, 5-(self.now()-self.last_send_finished)))
                if scheduled and ((not slept_before_send and china_day(self.now()) != schedule_day) or not await self.schedule.online() or self.schedule.enabled() and self.schedule.has_delivered(schedule_day, group)):
                    update('skipped', '发送前条件发生变化或已有报告，本次未发送。', 'failed'); return
                max_blocks = max(3, min(50, int(self.config.number('SUMMARY_MAX_BLOCKS', 20))))
                mode = self.config.get('SUMMARY_SEND_MODE', 'forward').lower()
                groups = [[block] for block in blocks] if mode == 'split' else [blocks[i:i+max_blocks] for i in range(0, len(blocks), max_blocks)]
                serial = 0
                async def tracked_send(send):
                    nonlocal serial
                    while not self.can_publish(group):
                        if not active():
                            raise ValueError('等待发送期间任务已失效')
                        await self.pause(5)
                    if not active():
                        raise ValueError('发送前任务已失效')
                    token = f'{account}:{id}:{serial}'; serial += 1
                    entry = {'groupId': group, 'jobId': id, 'at': self.now()*1000, 'status': 'reserved'}
                    self.receipts[token] = entry; write_json(self.receipts_file, self.receipts)
                    receipt_key = None
                    send_returned = False
                    try:
                        receipt_key = self.schedule.before_send(group)
                        receipt = await send()
                        send_returned = True
                        message_id = receipt_id(receipt)
                        self.schedule.acknowledged(receipt_key, receipt)
                        entry.update(status='confirmed', messageId=message_id)
                        write_json(self.receipts_file, self.receipts)
                    except BaseException as error:
                        if send_returned and not ambiguous_send(error):
                            error = SummarySendUncertain('报告已调用QQ，但回执持久化未确认；请先核对QQ')
                        entry['status'] = 'uncertain' if ambiguous_send(error) else 'failed'
                        self.schedule.failed(receipt_key, error)
                        try:
                            write_json(self.receipts_file, self.receipts)
                        except Exception as persistence_error:
                            raise SummarySendUncertain('报告发送记录无法持久化；请先核对QQ') from persistence_error
                        raise error
                for index, chunk in enumerate(groups):
                    while not self.can_publish(group):
                        if not active():
                            raise ValueError('发送前任务已失效')
                        await self.pause(5)
                    if not active():
                        raise ValueError('发送前任务已失效')
                    update('sending', '正在发送到本群')
                    if mode != 'split':
                        try:
                            nodes = [{'type':'node','data':{'name':self.config.get('BOT_NAME','Koukou'),'uin':account,'content':[{'type':'text','data':{'text':block}}]}} for block in chunk]
                            await tracked_send(lambda: self.onebot.api('send_group_forward_msg', {'group_id': group, 'messages': nodes}, timeout=120))
                            continue
                        except Exception as error:
                            if ambiguous_send(error):
                                raise
                    # A definite forward rejection may safely fall back; an uncertain result never does.
                    for block in chunk:
                        for piece in split_report_text(block):
                            await tracked_send(lambda piece=piece: self.onebot.send(key, piece))
                        await self.pause(1)
                    if index+1 < len(groups):
                        await self.pause(1)
            update('done', '统计版报告已发送；未生成热门话题正文。' if degraded else '完整群总结已生成并发送到本群。', 'success', resultKind='statistics' if degraded else 'full')
        except asyncio.CancelledError:
            update('interrupted', '任务中断，请核对群内是否已发送后再重试。', 'failed'); raise
        except Exception as error:
            update('failed', '本次生成或发送失败：'+str(error)[:300], 'failed')
        finally:
            if 'blocks' in locals() and not dry_run:
                self.last_send_finished = self.now()
            self.running.discard(group)


def split_report_text(text, limit=1800):
    """Keep line boundaries where possible; each outgoing text is bounded without dropping content."""
    pieces = []
    while len(text) > limit:
        end = text.rfind('\n', 0, limit)
        end = end+1 if end >= limit//2 else limit
        pieces.append(text[:end]); text = text[end:]
    if text:
        pieces.append(text)
    return pieces
