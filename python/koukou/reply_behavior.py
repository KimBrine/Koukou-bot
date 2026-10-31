"""Optional pacing and fixed-library variety; no detection or account guarantees."""
from contextlib import asynccontextmanager
import asyncio
import random
import re
from .archive import stamp
from .state import read_json, write_json


def bounded(config, key, default, low, high):
    return max(low, min(high, config.number(key, default)))


def pacing_seconds(config, text):
    if not config.enabled('REPLY_PACING_ENABLED', False): return 0
    content = str(text or '')
    count = (len(re.findall(r'[A-Za-z0-9_]+|[^\s]', content))
             if config.get('REPLY_PACING_MODE', 'character') == 'word'
             else sum(not char.isspace() for char in content))
    return min(bounded(config,'REPLY_PACING_MAX_SECONDS',8,0,60),
               count / bounded(config,'REPLY_PACING_SPEED',8,1,60))


class FixedReplyVariety:
    def __init__(self, config):
        self.config, self.file = config, config.data_dir/'fixed-reply-history.json'
        value = read_json(self.file, {'version':1,'scopes':{}})
        if not isinstance(value,dict) or value.get('version')!=1 or not isinstance(value.get('scopes'),dict):
            raise ValueError('固定回复历史格式损坏，请保留文件后检查')
        self.scopes = value['scopes']
        for key, rows in self.scopes.items():
            if not re.fullmatch(r'[a-f0-9]{64}',key) or not isinstance(rows,list) or len(rows)>20 or any(not isinstance(row,str) or not re.fullmatch(r'[a-f0-9]{64}',row) for row in rows):
                raise ValueError('固定回复历史条目无效')

    def choose(self, choices, scope, *, rand=random.random):
        self.scopes = FixedReplyVariety(self.config).scopes
        choices = list(dict.fromkeys(choices))
        if not choices: return ''
        window = int(bounded(self.config,'FIXED_REPLY_VARIATION_WINDOW',3,1,20))
        recent = self.scopes.get(stamp(scope), [])[-window:]
        eligible = [text for text in choices if stamp(text) not in recent]
        if not eligible:
            positions = {value:index for index,value in enumerate(recent)}
            oldest = min(positions[stamp(text)] for text in choices)
            eligible = [text for text in choices if positions[stamp(text)]==oldest]
        return eligible[min(len(eligible)-1,max(0,int(rand()*len(eligible))))]

    def record(self, scope, text):
        if not self.config.enabled('FIXED_REPLY_VARIATION_ENABLED',False): return
        self.scopes = FixedReplyVariety(self.config).scopes
        key = stamp(scope)
        previous = self.scopes.pop(key, [])
        self.scopes[key] = [*previous[-19:],stamp(text)]
        self.scopes = dict(list(self.scopes.items())[-500:])
        write_json(self.file, {'version':1,'scopes':self.scopes})


class ReplyBehavior:
    def __init__(self, config, onebot):
        self.config, self.onebot = config, onebot
        self.fixed, self.active_peers, self.failed_session = FixedReplyVariety(config), {}, None

    @asynccontextmanager
    async def typing(self, event, *, current=lambda:True):
        client, peer = self.onebot, int(event.get('user_id',0))
        identity = lambda:(getattr(client,'ws',None),str(getattr(client,'self_id','')),getattr(client,'account_version',0))
        session = identity()
        enabled = (self.config.enabled('TYPING_STATUS_ENABLED',False)
                   and self.config.get('QQ_TRANSPORT','onebot')!='qq-official'
                   and self.config.get('ONEBOT_IMPLEMENTATION','auto')=='snowluma'
                   and not event.get('group_id') and peer>0 and current()
                   and bool(session[1]) and session!=self.failed_session)
        key = (*session,peer)
        if not enabled:
            yield
            return
        owner = key not in self.active_peers
        entry = self.active_peers.setdefault(key, {'count':0})
        entry['count'] += 1
        try:
            if owner:
                try:
                    await asyncio.wait_for(client.api('set_input_status',{'user_id':peer,'event_type':1},timeout=2),2.5)
                except asyncio.CancelledError: raise
                except Exception: self.failed_session = session
            yield
        finally:
            entry['count'] -= 1
            if entry['count']==0:self.active_peers.pop(key,None)
            if entry['count']==0 and session==identity():
                try:
                    await asyncio.wait_for(client.api('set_input_status',{'user_id':peer,'event_type':0},timeout=2),2.5)
                except Exception: pass
