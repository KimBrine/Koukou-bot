"""Durable native scheduled delivery; unknown QQ outcomes never become automatic retries."""
import asyncio
import copy
from datetime import datetime, timedelta
import json
import logging
import re
import time
from .custom import scope_allows
from .archive import stamp
from .forward_records import CHINA
from .messages import parse_message, quiet_hour
from .onebot import OneBotError
from .sessions import digest
from .state import read_json, write_json
from .summary_jobs import receipt_id


def day_key(at):
    return datetime.fromtimestamp(at, CHINA).strftime('%Y-%m-%d')


def memory_boundary(memory, key):
    value = getattr(memory, 'boundary', {}) if memory else {}
    return max(value.get('resetAt', 0), value.get('keyResetAt', {}).get(key, 0))


def render_scheduled(text, at):
    stamp = datetime.fromtimestamp(at, CHINA)
    fields = {'name':'你', 'qq':'', 'group':'', 'time':f'{stamp.year}/{stamp.month}/{stamp.day} {stamp:%H:%M:%S}', 'date':stamp.strftime('%Y-%m-%d'), 'args':''}
    return re.sub(r'\{(name|qq|group|time|date|args)\}', lambda m: fields[m[1]], text)


class SendGuard:
    def __init__(self, config, onebot, memory, settings, *, current=None, now=time.time):
        self.config, self.onebot, self.memory, self.settings = config, onebot, memory, settings
        self.current, self.now = current or (lambda key: True), now

    def identity(self):
        return [str(self.onebot.self_id), getattr(self.onebot, 'account_version', 0), getattr(getattr(self.onebot, 'timeline', None), 'session', 0)]

    def snapshot(self, key):
        return {'identity':self.identity(), 'persona':digest(self.config.persona(self.settings.get(key, {}).get('persona', ''))),
                'revision':getattr(self.config, 'persona_revision', 0), 'memoryVersion':self.memory.version(key) if self.memory else 0,
                'memoryBoundary':memory_boundary(self.memory, key), 'settings':stamp(self.settings.get(key, {}))}

    def enabled(self, key):
        settings = self.settings.get(key, {})
        spec = settings.get('quietHours') if settings.get('quietHours') is not None else self.config.get('QUIET_HOURS')
        return settings.get('enabled') is not False and (not key.startswith('g') or int(key[1:]) not in self.config.ids('MUTED_GROUPS')) and not quiet_hour(spec, datetime.fromtimestamp(self.now(), CHINA)) and self.current(key)

    def allowed(self, key):
        health = self.onebot.status()
        return bool(self.onebot.self_id) and self.enabled(key) and bool(health.get('online')) and health.get('probeVerified', True)

    def valid(self, key, snapshot):
        return self.allowed(key) and snapshot == self.snapshot(key)

    async def online(self, key, snapshot):
        try:
            health = await self.onebot.refresh_status()
            return health.get('online') is True and health.get('connected') is True and self.valid(key, snapshot)
        except Exception:
            return False


async def verify_delivery(onebot, entry):
    """A matching actual bot message proves delivery. Absence never proves non-dispatch."""
    if not entry.get('selfId') or not entry.get('text') or str(onebot.self_id) != entry['selfId']:
        return {'status':'unknown'}
    try:
        response = await onebot.api('get_group_msg_history', {'group_id':entry['groupId'], 'count':100}, timeout=8)
        for message in response.get('messages', []):
            raw = message.get('message', message.get('raw_message', ''))
            stamp_ms = float(message.get('time') or 0)*1000
            if str(message.get('user_id', (message.get('sender') or {}).get('user_id'))) != entry['selfId'] or not entry['attemptAt']-2000 <= stamp_ms <= entry['attemptAt']+180000:
                continue
            parsed = parse_message(raw, entry['selfId'])
            if parsed.text.replace('\r\n', '\n').strip() != entry['text'].replace('\r\n', '\n').strip():
                continue
            if entry.get('target') and str(entry['target']) not in parsed.mentions:
                continue
            return {'status':'present', 'messageId':receipt_id({'message_id':message.get('message_id')})}
    except Exception:
        pass
    return {'status':'unknown'}


class DurableDelivery:
    def __init__(self, file, *, now=time.time):
        self.file, self.now, self.blocked, self.busy = file, now, False, set()
        try:
            value = read_json(file, {'version':1, 'deliveries':{}})
            if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('deliveries'), dict) or any(not isinstance(e, dict) or e.get('status') not in {'reserved','sending','uncertain','sent','retry','abandoned'} for e in value['deliveries'].values()):
                raise ValueError('定时发送记录格式错误')
            self.entries = value['deliveries']
        except (ValueError, OSError, TypeError):
            self.entries, self.blocked = {}, True

    def save(self):
        try:
            cutoff = self.now()*1000-14*86400000
            self.entries = {k:v for k,v in self.entries.items() if v.get('targetAt', v.get('attemptAt', self.now()*1000)) >= cutoff}
            write_json(self.file, {'version':1, 'deliveries':self.entries})
        except Exception:
            self.blocked = True
            raise

    def abandon(self, token, **fields):
        if self.blocked or token in self.entries:
            return
        self.entries[token] = {**fields, 'status':'abandoned'}; self.save()

    def status(self):
        return copy.deepcopy({'blocked':self.blocked, 'deliveries':self.entries})

    async def deliver(self, token, fields, send, *, valid=lambda:True, verify=None, retry_delay=30):
        if self.blocked or token in self.busy:
            return {'status':'blocked'}
        self.busy.add(token)
        entry = self.entries.get(token)
        try:
            if entry:
                if entry['status'] in {'sent','abandoned'}:
                    return {**entry, 'existing':True}
                if self.now()*1000 < entry.get('nextAttemptAt', 0):
                    return {**entry, 'existing':True}
                if any(entry.get(k) != fields.get(k) for k in ['fingerprint','selfId']):
                    entry.update(status='abandoned', reason='账号、人格或手动设置已变化；旧任务不重放'); self.save(); return {**entry, 'existing':True}
                if entry['status'] in {'reserved','sending','uncertain'}:
                    proof = {'status':'unknown'}
                    if verify:
                        try:
                            proof = await verify(entry)
                        except Exception:
                            pass
                    if proof.get('status') == 'present' and valid():
                        entry.update(status='sent', messageId=receipt_id({'message_id':proof.get('messageId')}), sentAt=self.now()*1000, verifiedFromHistory=True)
                    else:
                        entry.update(status='uncertain', nextAttemptAt=self.now()*1000+retry_delay*1000)
                    self.save(); return {**entry, 'existing':True, 'newlyConfirmed':proof.get('status') == 'present' and entry['status'] == 'sent'}
                if entry.get('attempts', 0) >= 3:
                    entry['status'] = 'abandoned'; self.save(); return {**entry, 'existing':True}
            if not valid():
                return {'status':'skipped'}
            entry = self.entries[token] = {**(entry or {}), **fields, 'status':'reserved', 'attemptAt':self.now()*1000, 'attempts':(entry or {}).get('attempts', 0)+1}
            self.save()  # No mutation is dispatched until its intent is durable.
            if not valid():
                entry['status'] = 'abandoned'; self.save(); return dict(entry)
            try:
                result = await send()
                message_id = receipt_id(result)
            except asyncio.CancelledError:
                entry['status'] = 'uncertain'; self.save(); raise
            except Exception as error:
                no_dispatch = isinstance(error, OneBotError) and not error.outcome_unknown and re.fullmatch(r'OneBot\s*未连接|发送前已断开', str(error))
                entry.update(status='retry' if no_dispatch else 'uncertain', nextAttemptAt=self.now()*1000+retry_delay*1000)
                self.save(); return dict(entry)
            entry.update(status='sent', messageId=message_id, sentAt=self.now()*1000)
            try:
                self.save()
            except Exception:
                entry['status'] = 'uncertain'
                raise
            return dict(entry)
        finally:
            self.busy.discard(token)


class ScheduledCommands:
    def __init__(self, config, onebot, commands, memory, settings, *, rate_limiter=None, current=None, now=time.time, retry_window=300, retry_delay=30, verify=None):
        self.config, self.onebot, self.commands, self.memory, self.settings = config, onebot, commands, memory, settings
        self.rate_limiter, self.now, self.retry_window, self.retry_delay = rate_limiter, now, retry_window, retry_delay
        self.guard = SendGuard(config, onebot, memory, settings, current=current, now=now)
        self.ledger = DurableDelivery(config.data_dir/'custom-command-delivery.json', now=now)
        self.verify = verify or (lambda entry: verify_delivery(onebot, entry))
        self.busy, self.stopped, self.task = False, False, None
        self.log = logging.getLogger('koukou.custom.schedule')

    def due(self):
        at, today, due = self.now(), datetime.fromtimestamp(self.now(), CHINA), {}
        for command in self.commands.all():
            if not command['enabled'] or not command['scheduleEnabled'] or command['responseMode'] != 'fixed' or command['event'] != 'message':
                continue
            for offset in [-1,0]:
                for clock in command['scheduleTimes']:
                    hour, minute = map(int, clock.split(':'))
                    target = (today+timedelta(days=offset)).replace(hour=hour, minute=minute, second=0, microsecond=0)
                    if not 0 <= at-target.timestamp() < self.retry_window:
                        continue
                    for group in command['scheduleGroups']:
                        if scope_allows(command, {'groupId':group, 'isPrivate':False}) and (command['scope'] != 'groups' or group in command['groups']):
                            token = json.dumps([command['id'],group,target.strftime('%Y-%m-%d'),clock], ensure_ascii=False, separators=(',',':'))
                            due[token] = {'command':command, 'groupId':group, 'targetAt':target.timestamp()*1000, 'slotKey':token}
        return sorted(due.values(), key=lambda item:item['targetAt'])

    def status(self):
        return self.ledger.status()

    async def tick(self):
        if self.busy or self.stopped or self.ledger.blocked:
            return False
        self.busy = True
        try:
            for item in self.due():
                token, group, command = item['slotKey'], item['groupId'], item['command']; key = 'g'+str(group)
                if not self.guard.enabled(key):
                    # Sleeping/disabled slots are consumed, never replayed on waking up.
                    self.ledger.abandon(token, targetAt=item['targetAt'], reason='本群暂停或寂静时段')
                    continue
                if not self.guard.allowed(key):
                    continue
                snapshot = self.guard.snapshot(key)
                def valid():
                    return not self.stopped and self.now()*1000-item['targetAt'] < self.retry_window*1000 and self.guard.valid(key,snapshot) and command in self.commands.all()
                if not await self.guard.online(key,snapshot) or not valid():
                    continue
                if self.rate_limiter and not self.rate_limiter.check(key,self.now())['allowed']:
                    continue
                text = render_scheduled(command['reply'], self.now())
                fields = {'groupId':group, 'targetAt':item['targetAt'], 'selfId':str(self.onebot.self_id), 'text':text,
                          'memoryBoundary':snapshot['memoryBoundary'], 'fingerprint':stamp([command,snapshot])}
                previous = self.ledger.entries.get(token)
                if previous and previous.get('text'):
                    fields['text'] = text = previous['text']
                result = await self.ledger.deliver(token, fields, lambda:self.onebot.send(key,text), valid=valid, verify=self.verify,retry_delay=self.retry_delay)
                if result.get('status') == 'sent' and (not result.get('existing') or result.get('newlyConfirmed')):
                    if self.rate_limiter:
                        self.rate_limiter.record(key,self.now())
                    if self.memory and valid():
                        self.memory.push(key,'assistant',text,time=self.now()*1000,messageId=result['messageId'])
            return True
        except Exception as error:
            self.log.warning('本轮自定义定时推送停止：%s',type(error).__name__)
            return False
        finally:
            self.busy = False

    def start(self):
        if self.task or self.ledger.blocked:
            return
        self.stopped = False
        async def loop():
            while not self.stopped:
                await self.tick(); await asyncio.sleep(30)
        self.task = asyncio.create_task(loop())

    async def close(self):
        self.stopped = True
        if self.task:
            self.task.cancel(); await asyncio.gather(self.task, return_exceptions=True); self.task = None
