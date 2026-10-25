"""History completeness requires reaching the boundary and a second stable scan."""
import asyncio
from datetime import datetime
import json
import os
from pathlib import Path
import re
import time
from .messages import parse_message


def merge_records(history, captured, start, end=float('inf')):
    items = {}
    for record in history:
        if start <= record['time'] < end and str(record['id']) not in items:
            items[str(record['id'])] = record
    for record in captured:
        if not start <= record['time'] < end:
            continue
        previous = items.get(str(record['id']), {})
        item = {**record}
        if previous.get('replyId') and not item.get('replyId'):
            item['replyId'] = previous['replyId']
        if previous.get('forwards') and not item.get('forwards'):
            item['forwards'] = previous['forwards']
        elif item.get('forwards'):
            forwards = []
            for segment in item['forwards']:
                data = segment.get('data', {})
                old = next((s for s in previous.get('forwards', []) if s.get('data', {}).get('id') == data.get('id') and data.get('id')), None)
                forwards.append({**segment, 'data': {**data, 'preview': old['data']['preview']}} if not data.get('preview') and old and old['data'].get('preview') else segment)
            item['forwards'] = forwards
        items[str(record['id'])] = item
    return sorted(items.values(), key=lambda r: r['time'])


def record_message(message, self_id=''):
    if not isinstance(message, dict) or message.get('message_id') is None or not message.get('user_id'):
        raise ValueError('历史消息缺少实际身份或编号')
    parsed = parse_message(message.get('message', message.get('raw_message', '')))
    sender = message.get('sender', {})
    at = float(message.get('time') or 0)
    return {'id': str(message['message_id']), 'time': at, 'userId': str(message['user_id']),
            'name': sender.get('card') or sender.get('nickname') or str(message['user_id']), 'text': parsed.text,
            'replyId': parsed.reply_id, **({'forwards': parsed.forwards} if parsed.forwards else {})}


class SummaryHistory:
    def __init__(self, onebot, *, unrestricted=True, pause=asyncio.sleep):
        self.onebot, self.unrestricted, self.pause = onebot, unrestricted, pause

    async def backfill(self, group, start, end, count=300, include_self=False):
        items, pages, reached, failed, complete = {}, 0, False, False, False
        retries, recoveries, restarts, stable, rounds = 0, 0, 0, 0, 0
        identity = (self.onebot.self_id, self.onebot.timeline.session)
        def active():
            if identity != (self.onebot.self_id, self.onebot.timeline.session):
                raise RuntimeError('历史读取期间账号或连接变化，未确认完整')
        def order(message):
            return (float(message.get('time') or 0), int(message.get('real_seq', message.get('message_seq', 0)) or 0))
        def missing(error):
            return bool(re.search(r'消息.*不存在|message.*(?:not found|does not exist)', str(error), re.I))
        async def read(seq, reverse):
            nonlocal retries
            active()
            params = {'group_id': int(group), 'count': min(500, max(200, count))}
            if seq is not None:
                params['message_seq'] = int(seq)
            if reverse:
                params['reverseOrder'] = True
            try:
                data = await self.onebot.api('get_group_msg_history', params, timeout=60)
            except Exception as error:
                transient = isinstance(error, TimeoutError) or bool(re.search('timeout|超时|ECONNRESET|temporary', str(error), re.I))
                if not transient or retries >= 3:
                    raise
                retries += 1; await self.pause(.7); active()
                data = await self.onebot.api('get_group_msg_history', params, timeout=60)
            active()
            if not isinstance(data, dict) or not isinstance(data.get('messages'), list):
                raise ValueError('QQ历史接口返回格式无效')
            for message in data['messages']:
                record_message(message)
            return data['messages']
        async def page(seq, anchor_page):
            nonlocal recoveries
            try:
                return await read(seq, True)
            except Exception as error:
                if not missing(error):
                    raise
                anchor = next((m for m in anchor_page if str(m.get('message_seq')) == str(seq)), None)
                candidates = sorted([m for m in anchor_page if m.get('message_seq') and str(m['message_seq']) != str(seq) and anchor and order(m) > order(anchor)], key=order)
                used = {str(seq)}
                for candidate in candidates:
                    if recoveries >= 6 or len(used) >= 4:
                        break
                    candidate_seq = str(candidate['message_seq'])
                    if candidate_seq in used:
                        continue
                    used.add(candidate_seq); recoveries += 1
                    try:
                        return await read(candidate['message_seq'], True)
                    except Exception as alternate:
                        if not missing(alternate):
                            raise
                raise error
        def add(messages):
            new = 0
            for message in messages:
                id = str(message['message_id'])
                if id not in items:
                    items[id] = message
                    new += start <= float(message.get('time') or 0) < end
            return new
        for round in range(1, 6):
            rounds = round
            try:
                first = await read(None, False)
            except Exception:
                failed = True; break
            if not first:
                failed = True; break
            pages += 1; new = add(first)
            seq = max(first, key=order).get('message_seq')
            if seq is None:
                failed = True; break
            anchor_page, seen, covered, cursor_failed = first, set(), False, False
            index = 0
            while self.unrestricted or index < 60:
                index += 1
                try:
                    messages = await page(seq, anchor_page)
                except Exception as error:
                    failed, cursor_failed = True, missing(error); break
                if not messages:
                    break
                pages += 1; new += add(messages)
                fresh = sum(str(m['message_id']) not in seen for m in messages)
                seen.update(str(m['message_id']) for m in messages)
                oldest = min(messages, key=order)
                if oldest.get('time') and float(oldest['time']) <= start:
                    covered = True; break
                next_seq = oldest.get('message_seq')
                if next_seq is None or str(next_seq) == str(seq) or fresh == 0:
                    break
                seq, anchor_page = next_seq, messages
            if failed and cursor_failed and restarts < 2 and round < 5:
                restarts += 1; failed = False; await self.pause(.7); continue
            if failed:
                break
            reached |= covered
            if covered and new == 0 and round > 1:
                complete = True; break
            stable = stable+1 if not covered and new == 0 else 0
            if stable >= 2:
                break
            if round < 5:
                await self.pause(.7)
        records = [record_message(m) for m in items.values() if float(m.get('time') or 0) < end and str(m['user_id']) != self.onebot.self_id]
        times = [r['time'] for r in records if r['time'] > 0]
        return {'records': records, 'complete': complete, 'reason': '' if complete else 'api_failed' if failed else 'history_not_stable' if reached else 'start_not_reached',
                'earliestSec': min(times) if times else 0, 'pages': pages, 'rounds': rounds,
                **({'rawMessages': list(items.values())} if include_self else {})}


class DailyArchive:
    def __init__(self, config, onebot):
        self.config, self.onebot = config, onebot
        self.root = config.data_dir / 'daily'

    def file(self, group, day):
        if not re.fullmatch(r'\d{1,15}', str(group)) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise ValueError('归档目录无效')
        path = self.root / str(group) / (day+'.jsonl')
        if self.root.is_symlink() or path.parent.is_symlink() or path.is_symlink():
            raise ValueError('归档不支持符号链接')
        return path

    def capture(self, event, parsed):
        if not event.get('group_id') or not self.config.enabled('SUMMARY_ENABLED') or int(event['group_id']) not in self.config.ids('WHITELIST_GROUPS') | self.config.ids('SUMMARY_GROUPS') or str(event['user_id']) == self.onebot.self_id:
            return
        record = record_message(event)
        record.update(text=parsed.text, atBot=parsed.at_bot)
        day = datetime.fromtimestamp(record['time'] or time.time()).strftime('%Y-%m-%d')
        file = self.file(event['group_id'], day)
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open('a', encoding='utf-8', newline='\n') as stream:
            stream.write(json.dumps(record, ensure_ascii=False, separators=(',', ':'))+'\n')
            stream.flush(); os.fsync(stream.fileno())

    def read(self, group, days):
        result = []
        for day in days:
            file = self.file(group, day)
            if not file.exists():
                continue
            for line in file.read_text(encoding='utf-8-sig').splitlines():
                if not line.strip():
                    continue
                # A corrupt line is not silently counted as a complete local archive.
                value = json.loads(line)
                if not isinstance(value, dict) or not all(k in value for k in ['id', 'time', 'userId', 'text']):
                    raise ValueError('群消息归档损坏，请检查原文件')
                result.append(value)
        return result
