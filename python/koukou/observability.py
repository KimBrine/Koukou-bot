"""Private operational records and read-only diagnostics for the native runtime.

Counters retain the existing console schema. No constructor sends messages, probes
ports, calls a model, or writes sample data. Notifications require an explicit call
and reserve a durable throttle before attempting a send with an unknown outcome.
"""
import asyncio
from collections import deque
import copy
from datetime import datetime, timedelta, timezone
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import time
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit, urlunsplit
from .state import read_json, write_json


CHINA = timezone(timedelta(hours=8))
FIELDS = ('received', 'replied', 'skipped', 'errors', 'stickers', 'searches', 'llmMs', 'llmCount')
SECRET_NAME = re.compile(r'(?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token|key|signature|credential|^sig$)', re.I)


def timestamp():
    return int(time.time()*1000)


def day_key(at=None):
    return datetime.fromtimestamp((timestamp() if at is None else at)/1000, CHINA).strftime('%Y-%m-%d')


def configured_secrets(config):
    values = getattr(config, 'values', config if isinstance(config, dict) else {})
    result = []
    for key, value in values.items():
        value = str(value or '')
        if re.search(r'(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$', str(key), re.I) and len(value) >= 4:
            result.append(value)
        if re.match(r'(?:https?|wss?)://', value, re.I):
            try:
                parts = urlsplit(value)
                result.extend(item for name, item in parse_qsl(parts.query) if SECRET_NAME.search(name) and len(item) >= 4)
                if parts.password:
                    result.append(parts.password)
            except ValueError:
                pass
    return tuple(sorted(set(result), key=len, reverse=True))


def redact(value, secrets=()):
    """Redact configured values and credential-shaped text before any log/UI sink."""
    text = str(value or '')
    secrets = secrets() if callable(secrets) else secrets
    for secret in secrets:
        if secret:
            for form in set([str(secret), quote(str(secret), safe='')]):
                text = text.replace(form, '[凭据]')
    text = re.sub(r'(?i)(Bearer\s+)[^\s,;\"\'}]+', r'\1[凭据]', text)
    text = re.sub(r'(?i)([\"\x27]?(?:api[_-]?key|access[_-]?token|password|passwd|secret|authorization)[\"\x27]?\s*[:=]\s*[\"\x27]?)([^\s\"\x27,;}]+)', r'\1[凭据]', text)
    text = re.sub(r'(?<![\w-])sk-[A-Za-z0-9_-]{12,}', '[凭据]', text)
    def url(match):
        raw = match[0]
        try:
            parts = urlsplit(raw)
            host = parts.hostname or ''
            if ':' in host:
                host = '['+host+']'
            if parts.port:
                host += ':'+str(parts.port)
            if parts.username or parts.password:
                host = '[凭据]@'+host
            pairs = []
            for name, value in parse_qsl(parts.query, keep_blank_values=True):
                # parse_qsl decodes percent escapes; redact again so decoding can
                # never reveal a configured secret hidden under another name.
                for secret in secrets:
                    if secret:
                        value = value.replace(str(secret), '[凭据]')
                pairs.append((name, '[凭据]' if SECRET_NAME.search(name) else value))
            # A signed resource can place an opaque token in the fragment too.
            fragment = '[凭据]' if parts.fragment else ''
            return urlunsplit((parts.scheme, host, parts.path, urlencode(pairs), fragment))
        except ValueError:
            return '[请求地址]'
    return re.sub(r'(?:https?|wss?)://[^\s<>\"\x27]+', url, text)


def _counter(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


class Metrics:
    def __init__(self, file, *, now=timestamp, logger=None, flush_seconds=30):
        self.file, self.now, self.logger, self.flush_seconds = Path(file), now, logger, flush_seconds
        self.data = read_json(self.file, {'days': {}})
        if not isinstance(self.data, dict) or not isinstance(self.data.get('days'), dict):
            raise ValueError('运行指标格式无效，未覆盖原文件')
        for key, row in self.data['days'].items():
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', key) or not isinstance(row, dict):
                raise ValueError('运行指标日期格式无效，未覆盖原文件')
            if any(not _counter(row[field]) for field in FIELDS if field in row):
                raise ValueError('运行指标计数无效，未覆盖原文件')
            if 'groups' in row and (not isinstance(row['groups'], list) or any(not isinstance(item, str) for item in row['groups'])):
                raise ValueError('运行指标群列表无效，未覆盖原文件')
        self.dirty, self.timer = False, None

    def _changed(self):
        self.dirty = True
        days = self.data['days']
        for key in sorted(days)[:-60]:
            del days[key]
        if self.timer is None:
            try:
                self.timer = asyncio.get_running_loop().call_later(self.flush_seconds, self._scheduled_flush)
            except RuntimeError:
                pass  # Synchronous callers explicitly flush at shutdown.

    def _scheduled_flush(self):
        self.timer = None
        self.flush()

    def bump(self, field, amount=1):
        if field not in FIELDS or not _counter(amount):
            raise ValueError('运行指标字段或增量无效')
        row = self.data['days'].setdefault(day_key(self.now()), {})
        row[field] = row.get(field, 0)+amount
        self._changed()

    def received(self): self.bump('received')
    def replied(self): self.bump('replied')
    def skipped(self): self.bump('skipped')
    def error(self): self.bump('errors')
    def sticker(self): self.bump('stickers')
    def search(self): self.bump('searches')

    def llm(self, ms):
        value = float(ms) if isinstance(ms, (int, float)) and not isinstance(ms, bool) and math.isfinite(ms) else 0
        self.bump('llmMs', max(0, math.floor(value+.5)))
        self.bump('llmCount')

    def group(self, id):
        row = self.data['days'].setdefault(day_key(self.now()), {})
        groups = row.setdefault('groups', [])
        if str(id) not in groups:
            groups.append(str(id))
            self._changed()

    def snapshot(self, days=7):
        try:
            days = max(1, min(60, int(days)))
        except (ValueError, TypeError, OverflowError):
            days = 7
        out = []
        for delta in range(days-1, -1, -1):
            key = day_key(self.now()-delta*86400000)
            row = self.data['days'].get(key, {})
            out.append({'date': key, **{field: row.get(field, 0) for field in FIELDS}, 'groups': len(row.get('groups', []))})
        return out

    def flush(self):
        if not self.dirty:
            return True
        try:
            write_json(self.file, self.data)
            self.dirty = False
            return True
        except OSError:
            if self.logger:
                self.logger.warning('运行指标保存失败，计数仍保留在内存')
            return False

    def close(self):
        if self.timer:
            self.timer.cancel()
            self.timer = None
        return self.flush()


class RuntimeStats:
    def __init__(self, *, now=timestamp):
        self.now, self.started_at = now, now()
        self.received, self.replies, self.last_message, self.by_day = {}, {}, {}, {}
        self.total_received = self.total_replied = self.total_skipped = 0

    def note_message(self, key, at=None):
        self.received[key] = self.received.get(key, 0)+1
        self.last_message[key] = self.now() if at is None else at
        self.total_received += 1

    def note_reply(self, key):
        self.replies[key] = self.replies.get(key, 0)+1
        self.total_replied += 1
        day = day_key(self.now())
        self.by_day[day] = self.by_day.get(day, 0)+1

    def note_skip(self):
        self.total_skipped += 1

    @property
    def today_replies(self):
        return self.by_day.get(day_key(self.now()), 0)

    def snapshot(self):
        return {'startedAt': self.started_at, 'uptimeSec': max(0, math.floor((self.now()-self.started_at)/1000+.5)),
                'received': dict(self.received), 'replies': dict(self.replies), 'lastMessage': dict(self.last_message),
                'today_replies': self.today_replies,
                'counters': {'received': self.total_received, 'replied': self.total_replied, 'skipped': self.total_skipped}}


class ReplyLog(dict):
    """Bounded source-compatible group:user -> last confirmed reply milliseconds.

    This is runtime state, not a second copy of private conversation contents.
    Call note only after QQ confirms at least one line of the reply paragraph.
    """
    def __init__(self, *, limit=10000, now=timestamp):
        super().__init__()
        self.limit, self.now = max(1, int(limit)), now

    def note(self, event, at=None):
        if not event.get('group_id') or not event.get('user_id'):
            return
        key = str(event['group_id'])+':'+str(event['user_id'])
        self.pop(key, None)
        self[key] = self.now() if at is None else at
        while len(self) > self.limit:
            del self[next(iter(self))]


class ErrorStore:
    def __init__(self, file, *, limit=200, now=timestamp, secrets=()):
        self.file, self.limit, self.now, self.secrets = Path(file), max(1, int(limit)), now, secrets
        values = read_json(self.file, [])
        if not isinstance(values, list) or any(not isinstance(item, dict) or not _counter(item.get('time')) or not isinstance(item.get('message'), str) for item in values):
            raise ValueError('错误记录格式无效，未覆盖原文件')
        self.items = deque(values[-self.limit:], maxlen=self.limit)

    def add(self, message, scope='bot', level='error'):
        row = {'time': self.now(), 'scope': redact(scope, self.secrets)[:80], 'level': level if level in {'error', 'warn', 'info'} else 'error',
               'message': redact(message, self.secrets)[:4000]}
        self.items.append(row)
        write_json(self.file, list(self.items))
        return copy.deepcopy(row)

    def list(self):
        # Legacy records can predate redaction; apply the current policy on reads.
        return [{**copy.deepcopy(item), 'message': redact(item['message'], self.secrets), 'scope': redact(item.get('scope', 'bot'), self.secrets)} for item in reversed(self.items)]

    def clear(self):
        write_json(self.file, [])
        self.items.clear()


class NativeLogger:
    def __init__(self, file=None, *, level='info', errors=None, metrics=None, secrets=(), now=timestamp, stream=None, max_bytes=10*1024*1024):
        self.file = Path(file) if file else None
        self.minimum = {'debug': 10, 'info': 20, 'warn': 30, 'warning': 30, 'error': 40}.get(str(level).lower(), 20)
        self.errors, self.metrics, self.secrets, self.now, self.stream, self.max_bytes = errors, metrics, secrets, now, stream, max_bytes

    def _write(self, level, message, *args, **kwargs):
        number = {'DEBUG': 10, 'INFO': 20, 'WARN': 30, 'ERROR': 40}[level]
        if number < self.minimum:
            return
        try:
            text = str(message) % args if args else str(message)
        except (ValueError, TypeError):
            text = ' '.join(str(value) for value in (message, *args))
        text = redact(text, self.secrets)
        stamp = datetime.fromtimestamp(self.now()/1000, CHINA).strftime('%Y/%m/%d %H:%M:%S')
        line = f'[{stamp}] [{level}] {text}'
        if self.stream:
            try:
                self.stream.write(line+'\n'); self.stream.flush()
            except (OSError, UnicodeError):
                pass
        if self.file:
            try:
                self.file.parent.mkdir(parents=True, exist_ok=True)
                if self.file.exists() and self.file.stat().st_size > self.max_bytes:
                    old = Path(str(self.file)+'.old')
                    if old.exists():
                        os.replace(old, Path(str(old)+'.bak'))
                    os.replace(self.file, old)
                with self.file.open('a', encoding='utf-8', newline='\n') as handle:
                    handle.write(line+'\n')
            except OSError:
                pass  # Logging failure cannot recursively break message delivery.
        if level in {'WARN', 'ERROR'} and self.errors:
            try:
                self.errors.add(text, level='warn' if level == 'WARN' else 'error')
            except OSError:
                pass
        if level == 'ERROR' and self.metrics:
            self.metrics.error()

    def debug(self, message, *args, **kwargs): self._write('DEBUG', message, *args, **kwargs)
    def info(self, message, *args, **kwargs): self._write('INFO', message, *args, **kwargs)
    def warning(self, message, *args, **kwargs): self._write('WARN', message, *args, **kwargs)
    warn = warning
    def error(self, message, *args, **kwargs): self._write('ERROR', message, *args, **kwargs)
    exception = error

    def handler(self):
        """Optional explicit handler for logging.getLogger('koukou.*') records."""
        target = self
        class Handler(logging.Handler):
            def emit(self, record):
                method = target.error if record.levelno >= 40 else target.warning if record.levelno >= 30 else target.info if record.levelno >= 20 else target.debug
                method(record.getMessage())
        return Handler()


def health_alert_for_error(text, *, secrets=()):
    text = re.sub(r'\s+', ' ', redact(text, secrets))
    if re.search(r'OneBot|QQ 消息发送失败', text):
        suffix = '。发送超时表示结果未确认，请先核对群内消息，不要直接重复发送。' if re.search(r'send_\w*msg|消息发送失败', text) else '。请检查 QQ 登录和接口连接状态。'
        return {'key': 'qq-delivery', 'text': 'QQ 接口异常：'+text[:180]+suffix}
    if re.search(r'余额|额度|quota|429|401|403|请求参数错误|超时|timeout|ECONN|socket hang up', text, re.I):
        return {'key': 'model-health', 'text': '模型调用可能异常：'+text[:180]}
    return None


class Notifier:
    def __init__(self, config, onebot, file, *, logger=None, now=timestamp, current=lambda: True):
        self.config, self.onebot, self.file, self.logger, self.now, self.current = config, onebot, Path(file), logger, now, current
        self.state = read_json(self.file, {})
        if not isinstance(self.state, dict) or any(not _counter(value) for value in self.state.values()):
            raise ValueError('通知节流记录无效，未覆盖原文件')
        self.secrets = lambda:configured_secrets(config)
        self.lock = asyncio.Lock()

    @property
    def admin(self):
        # Read dynamically so changing console administrators takes effect now.
        return next((value for value in re.split(r'[,，\s]+', str(self.config.get('ADMIN_USERS', ''))) if value.isdecimal() and int(value) > 0), '')

    async def notify(self, key, text, *, min_interval_ms=30*60*1000):
        if not self.onebot or not self.admin or not self.current():
            return False
        async with self.lock:
            stamp = self.now()
            if key in self.state and stamp-self.state[key] < min_interval_ms:
                return False
            # Reserve first: a lost acknowledgement must not produce a loop.
            self.state[key] = stamp
            write_json(self.file, self.state)
            admin = self.admin
            if not self.current() or not admin:
                return False
            try:
                receipt = await self.onebot.send('p'+admin, '[提醒] '+redact(text, self.secrets))
                confirmed = isinstance(receipt, dict) and receipt.get('message_id') is not None
                if self.logger:
                    self.logger.info('管理员通知已确认' if confirmed else '管理员通知结果未确认，不自动重发')
                return confirmed
            except (OSError, RuntimeError, ValueError) as exc:
                if self.logger:
                    self.logger.warning('管理员通知发送失败：%s', redact(exc, self.secrets))
                return False


class SelfCheck:
    """Inspect supplied state and local files only; never send probe messages."""
    def __init__(self, config, onebot=None, backup=None, *, now=timestamp):
        self.config, self.onebot, self.backup, self.now = config, onebot, backup, now

    def run(self, status=None):
        items = []
        def add(id, label, ok, detail='', level='error'):
            items.append({'id': id, 'label': label, 'ok': bool(ok), 'detail': detail, 'level': 'ok' if ok else level})
        key = bool(self.config.get('DEEPSEEK_API_KEY'))
        add('deepseek', 'DeepSeek Key', key, '已配置' if key else '未配置，聊天不可用')
        state = status if isinstance(status, dict) else self.onebot.status() if self.onebot else {}
        add('onebot', 'OneBot 连接', state.get('connected'), '已连接' if state.get('connected') else '未连接，检查协议端与接口地址')
        add('qq', 'QQ 在线', state.get('online'), '在线' if state.get('online') else '离线或状态未知', 'warn')
        directory = self.config.data_dir
        writable = directory.is_dir() and os.access(directory, os.W_OK)
        add('data', 'data 目录可写', writable, str(directory) if writable else '不可写，记忆与表情包无法保存')
        try:
            gb = shutil.disk_usage(directory).free/1024**3
            add('disk', '磁盘剩余空间', gb > 1, f'{gb:.1f} GB', 'warn')
        except OSError:
            add('disk', '磁盘剩余空间', False, '暂时无法读取', 'warn')
        if self.backup:
            try:
                entries = self.backup.list()
                last = max((entry.get('at', 0) for entry in entries), default=0)
                hours = (self.now()-last)/3600000 if last else math.inf
                add('backup', '最近备份', 0 <= hours < 48, f'{max(0, math.floor(hours+.5))} 小时前' if last else '还没有备份', 'warn')
            except (ValueError, OSError):
                add('backup', '最近备份', False, '备份记录无法读取', 'warn')
        for name in ['memory.json', 'chat-settings.json']:
            try:
                value = read_json(directory/name, {})
                if not isinstance(value, dict):
                    raise ValueError('invalid')
                add('file:'+name, name, True, '正常' if (directory/name).exists() else '尚未创建')
            except (ValueError, OSError):
                add('file:'+name, name, False, '文件损坏，无法解析')
        return {'at': self.now(), 'failed': sum(not item['ok'] for item in items), 'items': items}

    __call__ = run


def tail_log(file, lines=200, filter='', *, secrets=(), maximum=512*1024):
    try:
        lines = max(1, min(1000, int(lines)))
    except (ValueError, TypeError, OverflowError):
        lines = 200
    path = Path(file)
    if not path.is_file() or path.is_symlink():
        return []
    with path.open('rb') as stream:
        size = stream.seek(0, 2)
        stream.seek(max(0, size-maximum))
        data = stream.read(maximum)
    values = data.decode('utf-8', errors='replace').splitlines()
    if size > maximum and values:
        values.pop(0)
    return [redact(line, secrets) for line in values if line.strip() and (not filter or str(filter).lower() in line.lower())][-lines:]


def today_stats(daily_dir, memory=None, *, now=timestamp):
    """Count actual archived rows, falling back to recent-memory user originals."""
    date = day_key(now())
    result, total = [], 0
    directory = Path(daily_dir)
    if directory.is_dir() and not directory.is_symlink():
        for group in directory.iterdir():
            if not group.is_dir() or group.is_symlink() or not re.fullmatch(r'\d{1,24}', group.name):
                continue
            path = group/(date+'.jsonl')
            if not path.is_file() or path.is_symlink():
                continue
            with path.open('r', encoding='utf-8-sig') as stream:
                count = sum(bool(line.strip()) for line in stream)
            result.append({'groupId': group.name, 'count': count})
            total += count
    if not total and memory:
        start = datetime.strptime(date, '%Y-%m-%d').replace(tzinfo=CHINA).timestamp()*1000
        for key, records in memory.chats.items():
            count = sum(item.get('role') == 'user' and isinstance(item.get('time'), (int, float)) and start <= item['time'] < start+86400000 for item in records)
            if count:
                result.append({'groupId': key, 'count': count})
                total += count
    return {'date': date, 'total': total, 'perGroup': sorted(result, key=lambda row: (-row['count'], row['groupId']))}
