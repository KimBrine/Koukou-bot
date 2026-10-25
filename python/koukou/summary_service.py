"""Native report jobs; explicit completeness, persistent receipts and per-group progress."""
import asyncio
from datetime import datetime, timedelta
import json
import re
import time
from pathlib import Path
from .messages import quiet_hour
from .sessions import digest
from .state import read_json, write_json
from .summary_basics import SummaryProgress, content_profile, parse_summary_format, section_heading, summary_stats, topic_policy
from .summary_history import SummaryHistory, DailyArchive, merge_records
from .summary_quality import generate_checked

PROMPT = json.loads(Path(__file__).with_name('summary_prompt.json').read_text(encoding='utf-8'))['text']


def stats_block(stats):
    return '\n'.join(['📊 基础统计', f"• 消息总数: {stats['total']}", f"• 参与人数: {stats['people']}", f"• 总字符数: {stats['chars']}", f"• 表情数量: {stats['emoji']}", f"• 最活跃时段: {stats['peak']}"])


def report_date(start, end):
    fmt = lambda value: re.sub(r'^(\d{4})-(\d{2})-(\d{2})$', r'\1年\2月\3日', value)
    return fmt(start) if start == end else fmt(start)+' ~ '+fmt(end)


def replace_names(blocks, records):
    index = {}
    for record in records:
        id, name = str(record.get('userId', '')), re.sub(r'[\r\n]+', ' ', record.get('name', '')).strip()
        if not id.isdecimal() or not name or name == id:
            continue
        if name not in index.setdefault(id, []):
            index[id].append(name)
    out, section = [], None
    pattern = re.compile(r'\[\s*(?:@|QQ\s*(?:号)?\s*[:：]?\s*)?(\d+)\s*\]|(?<![0-9A-Za-z_])(?:@|QQ\s*(?:号)?\s*[:：]?\s*)?(\d{5,12})(?![0-9A-Za-z_])', re.I)
    for block in blocks:
        section = section_heading(block.split('\n')[0]) or section
        if section != 'topics':
            out.append(block); continue
        participants = re.search(r'^\s*参与者\s*[:：]([^\n]*)', block, re.M)
        participants = participants[1] if participants else ''
        protected = [(m.start(), m.end()) for m in re.finditer(r'https?://[^\s<>"）)]+', block)]
        for name in {n for names in index.values() for n in names}:
            for match in re.finditer(re.escape(name), block):
                left = block[match.start()-1:match.start()] if match.start() else ''
                right = block[match.end():match.end()+1]
                if not (re.search(r'[0-9A-Za-z_]', name[0]) and re.search(r'[0-9A-Za-z_]', left) or re.search(r'[0-9A-Za-z_]', name[-1]) and re.search(r'[0-9A-Za-z_]', right)):
                    protected.append((match.start(), match.end()))
        def replace(match):
            if any(match.start() < end and match.end() > start for start, end in protected):
                return match[0]
            id = match[1] or match[2]
            names = index.get(id)
            return next((n for n in names if n in participants), names[0]) if names else match[0]
        out.append(pattern.sub(replace, block))
    return out


def report_blocks(start, end, stats, text, records, statistics=False):
    title = '🎯 群聊日常分析报告'+('（统计版）' if statistics else '')+'\n📅 '+report_date(start, end)
    return [title, stats_block(stats), *replace_names(parse_summary_format(text)['blocks'], records)]


def build_prompt(config, days, label, stats, profile):
    user_table = '\n'.join(f"- {u['name']}（QQ {u['userId']}）：发言 {u['count']} 条｜平均 {u['avgChars']:g} 字｜表情占比 {u['emojiRatio']:g}｜回复比例 {u['replyRatio']:g}" for u in stats['users'])
    policy = topic_policy(profile)
    guide = f"完整窗口{profile['total']}条；有效普通文字{profile['ordinaryCount']}条；例行交互{profile['routineCount']}条。热门话题至少{policy['min']}项，优先{policy['target']}项；"+('不设固定条数上限。' if profile.get('unrestricted') else f"最多{policy['max']}项。")
    guide += '消息越多应保留更多有依据的细节，不挤压主要话题篇幅；少量例行指令、单个机器人播报和没有回应的单人片段不能凑热门话题。转发只作低权重参考，纯图片内容未知，禁止猜测。'
    guide += '\n人物证据：'+json.dumps(profile['people'], ensure_ascii=False)
    values = {'botName': config.get('BOT_NAME', 'Koukou'), 'dateLabel': label, 'userTable': user_table, 'contentGuide': guide, 'scope': '今天' if days == 1 else f'最近 {days} 天', **stats}
    return re.sub(r'\{\{(\w+)\}\}', lambda match: str(values[match[1]]), PROMPT)


class SummaryService:
    def __init__(self, config, onebot, model, memory, settings, *, now=time.time, pause=asyncio.sleep):
        self.config, self.onebot, self.model, self.memory, self.settings = config, onebot, model, memory, settings
        self.now, self.pause = now, pause
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

    def can_publish(self, group):
        key = 'g'+str(group); settings = self.settings.get(key, {})
        spec = settings.get('quietHours') if settings.get('quietHours') is not None else self.config.get('QUIET_HOURS')
        return not self.stopped and settings.get('enabled') is not False and int(group) not in self.config.ids('MUTED_GROUPS') and not quiet_hour(spec) and self.onebot.status().get('online', False)

    def groups(self):
        return sorted(self.config.ids('SUMMARY_GROUPS') or self.config.ids('WHITELIST_GROUPS'))

    def trigger(self, groups=None, days=1, dry_run=False, statistics=False):
        groups = self.groups() if groups is None else groups
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
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)

    async def run(self, group, job, dry_run=False, statistics=False):
        id, key, account = job['jobId'], 'g'+str(group), self.onebot.self_id
        persona = None
        revision = getattr(self.config, 'persona_revision', 0)
        boundary = self.memory.version(key)
        def active():
            return not self.stopped and self.onebot.self_id == account and getattr(self.config, 'persona_revision', 0) == revision and self.memory.version(key) == boundary and digest(self.config.persona(self.settings.get(key, {}).get('persona', ''))) == digest(persona)
        def update(stage, message, status='generating', **extra):
            return self.progress.update(group, id, stage=stage, message=message, status=status, **extra)
        try:
            persona = self.config.persona(self.settings.get(key, {}).get('persona', ''))
            if not dry_run and any(v.get('groupId') == group and v.get('status') in {'reserved', 'uncertain'} for v in self.receipts.values()):
                raise ValueError('本群存在发送结果不明的报告，请先核对QQ；未重复生成或发送')
            async with self.generate_lock:
                end = int(self.now()); end_date = datetime.fromtimestamp(end)
                start_date = end_date.replace(hour=0, minute=0, second=0, microsecond=0)-timedelta(days=job['days']-1)
                start = int(start_date.timestamp()); start_key, end_key = start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d')
                captured = self.archive.read(group, [(start_date+timedelta(days=i)).strftime('%Y-%m-%d') for i in range(job['days'])])
                history = await self.history.backfill(group, start, end, count=job['days']*300)
                if not history['complete']:
                    update('history', '历史记录未确认完整，本次没有发布报告。', 'failed'); return
                records = merge_records(history['records'], captured, start, end)
                if not records:
                    update('empty', '这段时间没有可总结的消息，未发送报告。', 'failed'); return
                stats = summary_stats(records); profile = content_profile(records, self.config.ids('SUMMARY_BOT_USERS'))
                profile['unrestricted'] = self.config.enabled('SUMMARY_UNRESTRICTED', True)
                if not active():
                    raise ValueError('人格、记忆边界或账号已变化')
                update('model', f"已核对完整历史，共{len(records)}条，正在生成正文")
                degraded = statistics
                if statistics:
                    text = 'ℹ️ 统计版说明\n本次按要求生成统计版，未调用模型。未生成热门话题、群友称号或原话点评；不代表今天没有讨论。'
                else:
                    if not self.model:
                        raise ValueError('总结模型未配置')
                    transcript = '\n'.join(f"[{datetime.fromtimestamp(r['time']):%m-%d %H:%M}] {r['name']}：{r['text']}" for r in records)
                    prompt = build_prompt(self.config, job['days'], report_date(start_key, end_key), stats, profile)
                    try:
                        text = await generate_checked(self.model, prompt, [{'role':'user','content':transcript}], records, stats, profile)
                    except Exception as error:
                        if not re.search('DataInspectionFailed|data_inspection_failed|content_filter|content_policy_violation', str(error), re.I):
                            raise
                        degraded = True
                        text = 'ℹ️ 统计版说明\n总结模型的内容检查未通过，本次无法生成正文。\n本报告仅包含程序核验的消息统计，未生成热门话题、群友称号或原话点评；不代表今天没有讨论。'
                if not active():
                    raise ValueError('生成期间人格或记忆边界变化，未发送旧报告')
                blocks = report_blocks(start_key, end_key, stats, text, records, degraded)
                if dry_run:
                    update('preview', '预览生成完成，未向群聊发送。', 'success', resultKind='statistics' if degraded else 'full'); return blocks
            update('queued', '正文已生成，等待本群可发送时段')
            while not self.can_publish(group):
                if not active():
                    raise ValueError('等待发送期间任务已失效')
                await self.pause(5)
            async with self.send_lock:
                max_blocks = max(1, int(self.config.number('SUMMARY_MAX_BLOCKS', 20)))
                mode = self.config.get('SUMMARY_SEND_MODE', 'forward')
                groups = [[block] for block in blocks] if mode == 'split' else [blocks[i:i+max_blocks] for i in range(0, len(blocks), max_blocks)]
                for index, chunk in enumerate(groups):
                    while not self.can_publish(group):
                        if not active():
                            raise ValueError('发送前任务已失效')
                        await self.pause(5)
                    if not active():
                        raise ValueError('发送前任务已失效')
                    update('sending', '正在发送到本群')
                    token = f'{account}:{id}:{index}'
                    entry = {'groupId': group, 'jobId': id, 'at': self.now()*1000, 'status': 'reserved'}
                    self.receipts[token] = entry; write_json(self.receipts_file, self.receipts)
                    try:
                        if mode == 'split':
                            receipt = await self.onebot.send(key, chunk[0])
                        else:
                            nodes = [{'type':'node','data':{'name':self.config.get('BOT_NAME','Koukou'),'uin':account,'content':[{'type':'text','data':{'text':block}}]}} for block in chunk]
                            receipt = await self.onebot.api('send_group_forward_msg', {'group_id': group, 'messages': nodes}, timeout=120)
                        if not isinstance(receipt, dict) or receipt.get('message_id') is None:
                            raise ValueError('QQ未返回消息编号，发送结果待核实')
                        entry.update(status='confirmed', messageId=str(receipt['message_id']))
                        write_json(self.receipts_file, self.receipts)
                    except BaseException:
                        entry['status'] = 'uncertain'; write_json(self.receipts_file, self.receipts); raise
                    if index+1 < len(groups):
                        await self.pause(1)
            update('done', '统计版报告已发送；未生成热门话题正文。' if degraded else '完整群总结已生成并发送到本群。', 'success', resultKind='statistics' if degraded else 'full')
        except asyncio.CancelledError:
            update('interrupted', '任务中断，请核对群内是否已发送后再重试。', 'failed'); raise
        except Exception as error:
            update('failed', '本次生成或发送失败：'+str(error)[:300], 'failed')
        finally:
            self.running.discard(group)
