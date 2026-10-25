"""Native daily fixed command and success-bound follow-up, without model calls."""
import asyncio
import copy
from datetime import datetime
import logging
import json
import os
import random
import re
import time
import uuid
import subprocess
import sys
from .forward_records import CHINA
from .messages import parse_message, segments
from .scheduled import DurableDelivery, SendGuard, day_key, verify_delivery
from .archive import stamp
from .state import read_json, write_json


async def chain_matches(source, text):
    """A user regex runs in a bounded process so backtracking cannot freeze QQ's event loop."""
    source, text = str(source)[:200], str(text)[:8000]
    if source == '抓到.*猪猪':
        return bool(re.search(source, text))
    script = 'import json,re,sys\ns,t=json.load(sys.stdin)\ntry: print(int(bool(re.search(s,t))))\nexcept re.error: print(int(bool(re.search("抓到.*猪猪",t))))'
    options = {'creationflags':subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    process = await asyncio.create_subprocess_exec(sys.executable,'-X','utf8','-c',script,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,**options)
    try:
        out,_ = await asyncio.wait_for(process.communicate(json.dumps([source,text],ensure_ascii=False).encode()),2)
        return process.returncode == 0 and out.strip() == b'1'
    except TimeoutError:
        return False
    finally:
        if process.returncode is None:
            process.kill(); await process.wait()


def daily_ping_target(clock, at):
    match = re.fullmatch(r'(\d{1,2}):(\d{2})', str(clock or '').strip())
    if not match:
        return None
    hour, minute = map(int, match.groups())
    if hour > 23 or minute > 59:
        return None
    return datetime.fromtimestamp(at, CHINA).replace(hour=hour,minute=minute,second=10 if hour == minute == 0 else 0,microsecond=0).timestamp()


class DailyPing:
    KEYS = ['DAILY_PING_ENABLED','DAILY_PING_TIME','DAILY_PING_GROUP','DAILY_PING_TARGET','DAILY_PING_TEXT','DAILY_PING_CHAIN_ENABLED','DAILY_PING_CHAIN_TEXT','DAILY_PING_CHAIN_MATCH','DAILY_PING_CHAIN_WINDOW_MS']

    def __init__(self, config, onebot, memory, settings, *, rate_limiter=None, current=None, now=time.time, rand=random.random, pause=asyncio.sleep):
        self.config,self.onebot,self.memory,self.settings = config,onebot,memory,settings
        self.rate_limiter,self.now,self.rand,self.pause = rate_limiter,now,rand,pause
        self.guard = SendGuard(config,onebot,memory,settings,current=current,now=now)
        self.file = config.data_dir/'daily-ping-state.json'
        self.ledger = DurableDelivery(config.data_dir/'daily-ping-delivery.json',now=now)
        self.daily = read_json(self.file,{})
        if not isinstance(self.daily,dict) or any(not str(k).isdecimal() or not isinstance(v,dict) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',str(v.get('date',''))) for k,v in self.daily.items()):
            raise ValueError('定时指令今日状态损坏，停止自动发送')
        self.busy,self.stopped,self.task = False,False,None
        self.pending_chain,self.follow_task,self.follow_tasks = None,None,set()
        self.last_sent_at = 0
        self.log = logging.getLogger('koukou.daily.ping')

    def config_values(self):
        return {k:self.config.get(k) for k in self.KEYS}

    def configured(self):
        group,target = self.config.get('DAILY_PING_GROUP').strip(),self.config.get('DAILY_PING_TARGET').strip()
        text = self.config.get('DAILY_PING_TEXT').strip()
        if not group.isdecimal() or not target.isdecimal() or not 0 < int(group) <= 9007199254740991 or not 0 < int(target) <= 9007199254740991 or not text or len(text)>4000:
            return None
        return {'group':int(group),'target':str(int(target)),'text':text,'clock':self.config.get('DAILY_PING_TIME','00:00')}

    @property
    def enabled(self):
        params = self.configured()
        return self.config.enabled('DAILY_PING_ENABLED',False) and params is not None and daily_ping_target(params['clock'],self.now()) is not None

    def state(self):
        return copy.deepcopy(self.daily)

    def today_note(self,key):
        match = re.fullmatch(r'g(\d+)',str(key))
        entry = self.daily.get(match[1],{}) if match else {}
        if entry.get('date') != day_key(self.now()) or entry.get('account',str(self.onebot.self_id)) != str(self.onebot.self_id):
            return ''
        parts = []
        if entry.get('pig'):
            count = entry.get('pigCount')
            note = '对方确认这是第一次获得这只猪，不要说“又是这只猪”或“第二次抽到”' if count == 1 else f'对方确认这是第{count}次获得这只猪' if isinstance(count,(int,float)) and count>1 else '这只猪的累计获得次数尚未确认，不要编造具体次数'
            parts.append(f'今天已确认抽到【{entry["pig"]}】；{note}，也不要把发送指令的次数当成抽中次数')
        elif entry.get('at'):
            parts.append('今天已经抽过「今日猪猪」，但猪名没有识别出来')
        elif entry.get('sentAt'):
            parts.append('今天已发送「今日猪猪」，尚未确认抽取成功；不能说已经抽到，更不能编造次数')
        if entry.get('penAt'):
            parts.append('也查过「我的猪圈」了')
        return '\n\n【今日已办（别再说没做过、也不要重复做）】'+'，'.join(parts)+'。' if parts else ''

    def describe(self):
        p = self.configured()
        if not self.enabled or not p:
            return '未启用'
        return f"每天 {p['clock']}"+(':10（午夜缓冲）' if p['clock'] in {'00:00','0:00'} else '')+f" → 群 {p['group']}：@{p['target']} {p['text']}"+('（对方成功回应后补发「'+self.config.get('DAILY_PING_CHAIN_TEXT')+'」）' if self.config.enabled('DAILY_PING_CHAIN_ENABLED',True) and self.config.get('DAILY_PING_CHAIN_TEXT') else '')

    def mark(self,group,**fields):
        gid,day = str(group),day_key(self.now())
        old = self.daily.get(gid,{})
        self.daily[gid] = {**(old if old.get('date') == day and old.get('account',str(self.onebot.self_id)) == fields.get('account',str(self.onebot.self_id)) else {}),'date':day,'account':str(self.onebot.self_id),**fields}
        write_json(self.file,self.daily)

    def done_today(self,group):
        value = self.daily.get(str(group),{})
        return value.get('date') == day_key(self.now()) and value.get('account',str(self.onebot.self_id)) == str(self.onebot.self_id) and bool(value.get('sentAt') or value.get('at') or value.get('pig'))

    def clear_chain(self):
        self.pending_chain = None

    async def send_now(self,reason='控制台手动触发',*,once_per_day=False):
        if self.busy or self.stopped or self.ledger.blocked:
            return False
        params = self.configured()
        if not params or once_per_day and (not self.enabled or self.done_today(params['group'])):
            return False
        self.busy = True
        try:
            p = params; key = 'g'+str(p['group']); at = self.now(); settings = self.config_values(); snapshot = self.guard.snapshot(key)
            token = f"{self.onebot.self_id}:{p['group']}:{day_key(at)}:main" if once_per_day else 'manual:'+uuid.uuid4().hex
            target = daily_ping_target(p['clock'],at) if once_per_day else at
            if target is None or once_per_day and not 0 <= at-target <= 10800:
                return False
            def valid():
                return not self.stopped and self.config_values() == settings and self.guard.valid(key,snapshot) and (not once_per_day or self.enabled and day_key(self.now()) == day_key(at) and 0 <= self.now()-target <= 10800)
            if not self.guard.enabled(key):
                if once_per_day:
                    self.ledger.abandon(token,targetAt=target*1000,reason='本群暂停或寂静时段')
                self.clear_chain(); return False
            if not self.guard.allowed(key):
                return False
            if not await self.guard.online(key,snapshot) or not valid():
                return False
            text = f"[@{p['target']}] {p['text']}"
            fields = {'groupId':p['group'],'target':p['target'],'targetAt':target*1000,'selfId':str(self.onebot.self_id),'text':text,'fingerprint':stamp([settings,snapshot])}
            async def send():
                return await self.onebot.send(key,[{'type':'at','data':{'qq':p['target']}},{'type':'text','data':{'text':' '+p['text']}}])
            result = await self.ledger.deliver(token,fields,send,valid=valid,verify=lambda e:verify_delivery(self.onebot,e),retry_delay=60)
            if result.get('status') != 'sent':
                return False
            if not result.get('existing') or result.get('verifiedFromHistory'):
                self.last_sent_at = self.now()*1000
                self.mark(p['group'],sentAt=self.last_sent_at,account=fields['selfId'])
                if self.rate_limiter:
                    self.rate_limiter.record(key,self.now())
                if self.memory and valid():
                    self.memory.push(key,'assistant',text,time=self.now()*1000,messageId=result['messageId'])
                if valid() and self.config.enabled('DAILY_PING_CHAIN_ENABLED',True) and self.config.get('DAILY_PING_CHAIN_TEXT').strip():
                    self.pending_chain = {'params':p,'settings':settings,'snapshot':snapshot,'key':key,'token':token,'messageId':result['messageId'],'armedAt':self.now(),
                                          'chainText':self.config.get('DAILY_PING_CHAIN_TEXT').strip(),'expiresAt':self.now()+max(10,self.config.number('DAILY_PING_CHAIN_WINDOW_MS',90000)/1000)}
            return True
        finally:
            self.busy = False

    def chain_valid(self,pending):
        return not self.stopped and self.now() <= pending['expiresAt'] and self.config_values() == pending['settings'] and self.guard.valid(pending['key'],pending['snapshot'])

    async def note_message(self,event,parsed=None):
        pending = self.pending_chain
        if not pending:
            return False
        if not self.chain_valid(pending):
            self.clear_chain(); return False
        p = pending['params']
        timeline = getattr(self.onebot,'timeline',None)
        if timeline and not timeline.current(event):
            return False
        if str(event.get('group_id')) != str(p['group']) or str(event.get('user_id')) != p['target'] or float(event.get('time') or 0) < pending['armedAt']-2:
            return False
        recipients = set()
        for segment in segments(event.get('message',event.get('raw_message'))):
            data = segment.get('data') or {}
            if segment.get('type') == 'at':
                recipients.add(str(data.get('qq','')))
            elif segment.get('type') == 'markdown':
                recipients.update(re.findall(r'mqqapi://markdown/mention\?[^)\s]*at_tinyid=(\d+)',str(data.get('content',''))))
        if recipients and str(self.onebot.self_id) not in recipients:
            return False
        parsed = parsed or parse_message(event.get('message',event.get('raw_message')),self.onebot.self_id)
        if parsed.reply_id and parsed.reply_id != pending['messageId']:
            return False
        source = self.config.get('DAILY_PING_CHAIN_MATCH') or '抓到.*猪猪'
        if not await chain_matches(source,parsed.text) or self.pending_chain is not pending or not self.chain_valid(pending):
            return False
        pig = re.search(r'【([^】]{1,20})】',parsed.text)
        count = re.search(r'第\s*(\d+)\s*次抓到',parsed.text)
        self.mark(p['group'],pig=pig[1] if pig else '',pigCount=1 if '抓到一只新猪猪' in parsed.text else int(count[1]) if count else None,at=self.now()*1000)
        self.clear_chain()
        async def follow():
            await self.pause(2+self.rand()*2)
            if self.chain_valid(pending):
                await self.send_follow_up(pending['chainText'],pending=pending)
        self.follow_task = asyncio.create_task(follow())
        self.follow_tasks.add(self.follow_task)
        def finished(task):
            self.follow_tasks.discard(task)
            if not task.cancelled() and task.exception():
                self.log.warning('定时链式指令未确认发送：%s',type(task.exception()).__name__)
        self.follow_task.add_done_callback(finished)
        return True

    async def send_follow_up(self,text,*,pending=None):
        if pending is None or not self.chain_valid(pending):
            return False
        p,key = pending['params'],pending['key']
        if not await self.guard.online(key,pending['snapshot']) or not self.chain_valid(pending):
            return False
        fields = {'groupId':p['group'],'target':p['target'],'targetAt':pending['armedAt']*1000,'selfId':str(self.onebot.self_id),'text':f"[@{p['target']}] {text}",'fingerprint':stamp([pending['settings'],pending['snapshot'],text])}
        result = await self.ledger.deliver(pending['token']+':chain',fields,lambda:self.onebot.send(key,[{'type':'at','data':{'qq':p['target']}},{'type':'text','data':{'text':' '+text}}]),valid=lambda:self.chain_valid(pending),verify=lambda e:verify_delivery(self.onebot,e))
        if result.get('status') != 'sent':
            return False
        if not result.get('existing') or result.get('newlyConfirmed'):
            self.mark(p['group'],penAt=self.now()*1000)
            if self.rate_limiter:
                self.rate_limiter.record(key,self.now())
            if self.memory and self.chain_valid(pending):
                self.memory.push(key,'assistant',fields['text'],time=self.now()*1000,messageId=result['messageId'])
        return True

    async def tick(self):
        if self.stopped:
            return False
        if self.pending_chain and not self.chain_valid(self.pending_chain):
            self.clear_chain()
        if not self.enabled:
            return False
        return await self.send_now('定时触发或启动补发',once_per_day=True)

    def start(self):
        if self.task or self.ledger.blocked:
            return
        self.stopped = False
        async def loop():
            while not self.stopped:
                try:
                    await self.tick()
                except Exception as error:
                    self.log.warning('本轮定时指令停止：%s',type(error).__name__)
                await asyncio.sleep(5)
        self.task = asyncio.create_task(loop())

    async def close(self):
        self.stopped = True; self.clear_chain()
        tasks = list(self.follow_tasks | ({self.task} if self.task else set()))
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        self.task = self.follow_task = None
