"""Fixed-library greetings, pinned to China-time boundaries and actual connection state."""
import asyncio
from datetime import datetime, timezone, timedelta
import random
import re
import time
from .sessions import digest
from .state import read_json, write_json

DAY, OFFSET = 86400000, 8*3600000


def greeting_window(spec, at):
    match = re.fullmatch(r"(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})", str(spec or "").strip())
    if not match:
        return None
    sh, sm, eh, em = map(int, match.groups())
    if sh > 23 or eh > 23 or sm > 59 or em > 59 or (sh, sm) == (eh, em):
        return None
    start_min, end_min = sh*60+sm, eh*60+em
    day = ((at+OFFSET)//DAY)*DAY-OFFSET
    start = day+start_min*60000
    if start > at:
        start -= DAY
    end = start+((end_min-start_min+1440)%1440)*60000
    return {"start": start, "end": end, "quiet": at < end, "ended": {"start": start, "end": end} if at >= end else {"start": start-DAY, "end": end-DAY}}


class QuietGreetings:
    def __init__(self, config, onebot, memory, settings, library, now=lambda: time.time()*1000, rand=random.random, gap=1.2):
        self.config, self.onebot, self.memory, self.settings, self.library = config, onebot, memory, settings, library
        self.now, self.rand, self.gap = now, rand, gap
        self.file = config.data_dir / 'quiet-greetings-state.json'
        self.state = read_json(self.file, {'version': 1, 'activatedAt': None, 'groups': {}, 'deliveries': {}})
        if self.state.get('version') != 1 or not isinstance(self.state.get('groups'), dict) or not isinstance(self.state.get('deliveries'), dict):
            raise ValueError('早晚安状态损坏，拒绝重复发送')
        self.last_at, self.last_online = now(), False
        self.last_connection = None
        self.busy, self.stopped = False, False

    def save(self):
        write_json(self.file, self.state)

    def status(self):
        groups = []
        for group in sorted(self.config.ids('WHITELIST_GROUPS')):
            context = self.context(group)
            if context:
                library = self.library.get(context['persona']) or {}
                morning, night = len(library.get('goodmorning', [])), len(library.get('goodnight', []))
                groups.append({'groupId': group, 'quietHours': context['spec'], 'ready': bool(morning and night), 'morningCount': morning, 'nightCount': night})
        return {'enabled': self.config.enabled('QUIET_GREETINGS_ENABLED', False), 'blocked': False, 'groups': groups}

    def context(self, group):
        key = 'g'+str(group)
        settings = self.settings.get(key, {})
        if settings.get('enabled') is False or group in self.config.ids('MUTED_GROUPS'):
            return None
        spec = settings.get('quietHours') if settings.get('quietHours') is not None else self.config.get('QUIET_HOURS')
        if not greeting_window(spec, self.now()):
            return None
        persona = self.config.persona(settings.get('persona', ''))
        return {'groupId': group, 'key': key, 'spec': spec, 'hash': digest(persona), 'persona': persona}

    def valid(self, context, kind, cycle):
        group, at = context['groupId'], self.now()
        health = self.onebot.status()
        if self.stopped or not self.config.enabled('QUIET_GREETINGS_ENABLED', False) or not health.get('online') or not health.get('probeVerified', True) or group not in self.config.ids('WHITELIST_GROUPS'):
            return False
        current = self.context(group)
        if current is None or current['spec'] != context['spec'] or current['hash'] != context['hash']:
            return False
        window = greeting_window(current['spec'], at)
        if kind == 'night':
            return window['quiet'] and window['start'] == cycle['start'] and at-cycle['start'] < 60000 and cycle['connection'] == self.connection()
        return not window['quiet'] and window['ended']['end'] == cycle['end']

    def connection(self):
        return (self.onebot.timeline.session, getattr(self.onebot, 'account_version', 0), str(self.onebot.self_id))

    async def send(self, context, kind, cycle):
        at = self.now()
        date = datetime.fromtimestamp((cycle['start'] if kind == 'night' else cycle['end'])/1000, timezone(timedelta(hours=8))).strftime('%Y-%m-%d')
        key = f"{self.onebot.self_id}:{context['groupId']}:{kind}:{date}"
        # Legacy receipts did not include account ID. Preserve them to avoid replay on migration.
        legacy = f"{context['groupId']}:{kind}:{date}"
        if key in self.state['deliveries'] or legacy in self.state['deliveries'] or not self.valid(context, kind, cycle):
            return
        library = self.library.get(context['persona'])
        choices = library.get('goodnight' if kind == 'night' else 'goodmorning', []) if library else []
        if not choices:
            return
        prior = sorted([v for v in self.state['deliveries'].values() if v.get('groupId') == context['groupId'] and v.get('kind') == kind and v.get('personaHash') == context['hash']], key=lambda v: v.get('at', 0), reverse=True)
        candidates = [text for text in choices if not prior or text != prior[0].get('text')] or choices
        from .reply_behavior import FixedReplyVariety
        variety = FixedReplyVariety(self.config)
        scope = ['greeting',str(self.onebot.self_id),context['key'],kind,context['hash']]
        text = (variety.choose(choices,scope,rand=self.rand)
                if self.config.enabled('FIXED_REPLY_VARIATION_ENABLED',False)
                else candidates[min(len(candidates)-1, max(0, int(self.rand()*len(candidates))))])
        entry = {'groupId': context['groupId'], 'kind': kind, 'at': at, 'status': 'pending', 'personaHash': context['hash'], 'text': text}
        self.state['deliveries'][key] = entry
        self.save()
        try:
            if not self.valid(context, kind, cycle):
                entry['status'] = 'skipped'; self.save(); return
            revision = self.memory.version(context['key'])
            result = await self.onebot.send(context['key'], text)
            if not isinstance(result, dict) or result.get('message_id') is None:
                entry['status'] = 'uncertain'
            else:
                entry.update(status='sent', messageId=str(result['message_id']))
                variety.record(scope,text)
                self.save()
                current = self.context(context['groupId'])
                if current and current['hash'] == context['hash'] and revision == self.memory.version(context['key']):
                    self.memory.push(context['key'], 'assistant', text, time=at, messageId=result['message_id'])
        except asyncio.CancelledError:
            entry['status'] = 'uncertain'; self.save(); raise
        except Exception:
            entry['status'] = 'uncertain'
        self.save()
        if self.gap:
            await asyncio.sleep(self.gap)

    async def tick(self, morning_catchup=False):
        if self.busy or self.stopped:
            return
        self.busy = True
        at = self.now()
        previous_at, previous_online = self.last_at, self.last_online
        connection = self.connection()
        same_connection = self.last_connection == connection
        self.last_at, self.last_online, self.last_connection = at, self.onebot.status().get('online', False), connection
        try:
            if not self.config.enabled('QUIET_GREETINGS_ENABLED', False):
                return
            if self.state['activatedAt'] is None:
                self.state['activatedAt'] = at; self.save()
            for group in sorted(self.config.ids('WHITELIST_GROUPS')):
                context = self.context(group)
                if not context:
                    continue
                prior = self.state['groups'].get(str(group))
                unchanged = prior is not None and prior['spec'] == context['spec']
                if not unchanged:
                    self.state['groups'][str(group)] = {'spec': context['spec'], 'since': at}; self.save()
                tracked = self.state['groups'][str(group)]
                window = greeting_window(context['spec'], at)
                if not self.last_online:
                    continue
                if window['quiet']:
                    if not morning_catchup and unchanged and previous_online and same_connection and previous_at < window['start'] <= at and at-window['start'] < 60000:
                        await self.send(context, 'night', {**window, 'connection': connection})
                elif morning_catchup or window['ended']['end'] >= max(self.state['activatedAt'], tracked['since']):
                    await self.send(context, 'morning', window['ended'])
        finally:
            self.busy = False

    async def catch_up_morning(self):
        if self.busy or self.stopped or not self.config.enabled('QUIET_GREETINGS_ENABLED', False) or not self.onebot.status().get('online'):
            raise ValueError('早晚安未就绪或QQ尚未确认在线')
        before = set(self.state['deliveries'])
        await self.tick(morning_catchup=True)
        added = [v for k, v in self.state['deliveries'].items() if k not in before and v['kind'] == 'morning']
        return {'ok': True, 'deliveries': added, 'sent': sum(v['status'] == 'sent' for v in added), 'uncertain': sum(v['status'] in {'pending', 'uncertain'} for v in added)}
