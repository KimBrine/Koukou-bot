"""Offline durable scheduling boundaries; no actual QQ connection or model calls."""
import asyncio
from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from koukou.config import Config
from koukou.custom import CustomCommands
from koukou.daily_ping import DailyPing, daily_ping_target, chain_matches
from koukou.memory import Memory
from koukou.messages import Timeline, parse_message
from koukou.onebot import OneBotError
from koukou.rate_limit import RateLimiter
from koukou.scheduled import DurableDelivery, ScheduledCommands, verify_delivery


class SchedulerFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.at = datetime.fromisoformat('2026-10-25T00:01:00+08:00').timestamp()
        self.config = Config(self.temp.name,environ={'QUIET_HOURS':'','PERSONA':'测试人格'})
        self.memory,self.settings = Memory(self.config.data_dir),{}
        self.rate = RateLimiter(100,0,now=lambda:self.at)
        outer = self
        class Protocol:
            self_id = '10'; account_version = 0
            def __init__(self):
                self.timeline = Timeline(now=lambda:outer.at); self.timeline.begin(); self.sent = []; self.health = {'online':True,'connected':True,'probeVerified':True}
                self.probe = None; self.error = None; self.history = []
            def status(self):
                return self.health
            async def refresh_status(self):
                if self.probe:
                    self.probe()
                return self.health
            async def send(self,key,message):
                self.sent.append((key,message))
                if self.error:
                    raise self.error
                return {'message_id':len(self.sent)}
            async def api(self,action,params,**kwargs):
                return {'messages':self.history}
        self.protocol = Protocol()
        self.commands = CustomCommands(self.config.data_dir/'custom-commands.json',now=lambda:self.at)
        self.command = self.commands.upsert({'id':'daily','trigger':'/提醒','reply':'日期 {date}，时间 {time}','scheduleEnabled':True,'scheduleGroups':[100],'scheduleTimes':['00:00']})
        self.scheduler = ScheduledCommands(self.config,self.protocol,self.commands,self.memory,self.settings,rate_limiter=self.rate,now=lambda:self.at)
        self.addAsyncCleanup(self.scheduler.close)


class ScheduledTests(SchedulerFixture):
    async def test_slot_is_durable_before_send_and_restarts_do_not_duplicate(self):
        original = self.protocol.send
        async def send(key,message):
            persisted = json.loads(self.scheduler.ledger.file.read_text(encoding='utf-8'))['deliveries']
            self.assertEqual(next(iter(persisted.values()))['status'],'reserved')
            return await original(key,message)
        self.protocol.send = send
        await self.scheduler.tick(); await self.scheduler.tick()
        other = ScheduledCommands(self.config,self.protocol,self.commands,self.memory,self.settings,now=lambda:self.at)
        await other.tick(); await other.close()
        self.assertEqual(len(self.protocol.sent),1)
        self.assertIn('2026-10-25',self.protocol.sent[0][1]); self.assertIn('00:01:00',self.protocol.sent[0][1])
        self.assertEqual(len(self.memory.get('g100')),1); self.assertEqual(len(self.rate.history['g100']),1)

    async def test_unknown_send_never_replays_even_when_verifier_says_absent(self):
        self.protocol.error = OneBotError('timeout',outcome_unknown=True)
        self.scheduler.verify = lambda entry: self.absent(entry)
        await self.scheduler.tick(); self.at += 31; self.protocol.error = None
        await self.scheduler.tick(); self.at += 31; await self.scheduler.tick()
        self.assertEqual(len(self.protocol.sent),1)
        self.assertEqual(next(iter(self.scheduler.status()['deliveries'].values()))['status'],'uncertain')
        self.assertEqual(self.memory.get('g100'),[]); self.assertEqual(len(self.rate.history.get('g100',[])),0)

    async def absent(self,entry):
        return {'status':'absent'}

    async def test_only_explicit_pre_dispatch_disconnect_retries(self):
        self.protocol.error = OneBotError('OneBot未连接')
        await self.scheduler.tick(); self.at += 31; self.protocol.error = None
        await self.scheduler.tick(); await self.scheduler.tick()
        self.assertEqual(len(self.protocol.sent),2)
        self.assertEqual(next(iter(self.scheduler.status()['deliveries'].values()))['status'],'sent')
        self.assertEqual(len(self.rate.history['g100']),1)

    async def test_quiet_slot_consumed_even_when_offline_and_not_replayed_on_wake(self):
        self.settings['g100'] = {'quietHours':'00:00-00:02'}
        self.protocol.health['online'] = False
        await self.scheduler.tick(); self.at += 90; self.protocol.health['online'] = True
        await self.scheduler.tick()
        self.assertEqual(self.protocol.sent,[])
        self.assertEqual(next(iter(self.scheduler.status()['deliveries'].values()))['status'],'abandoned')

    async def test_deleted_rule_or_memory_edit_or_persona_change_during_probe_stops_send(self):
        for change in [lambda:self.commands.remove('daily'),lambda:self.memory.clear('g100'),lambda:self.config.values.update(PERSONA='另一个人格')]:
            self.commands.replace([self.command]); self.protocol.probe = change
            await self.scheduler.tick()
        self.assertEqual(self.protocol.sent,[])

    async def test_late_slot_and_disabled_rule_do_not_send(self):
        self.at += 300; await self.scheduler.tick()
        self.at -= 300; self.commands.upsert({**self.command,'enabled':False}); await self.scheduler.tick()
        self.assertEqual(self.protocol.sent,[])
        self.commands.upsert(self.command); await self.scheduler.tick()
        self.assertEqual(len(self.protocol.sent),1)

    async def test_corrupt_journal_and_persist_failure_fail_closed(self):
        self.scheduler.ledger.file.parent.mkdir(parents=True,exist_ok=True)
        self.scheduler.ledger.file.write_text('{broken',encoding='utf-8')
        other = ScheduledCommands(self.config,self.protocol,self.commands,self.memory,self.settings,now=lambda:self.at)
        self.assertFalse(await other.tick()); self.assertTrue(other.status()['blocked']); await other.close()
        with patch('koukou.scheduled.write_json',side_effect=OSError('disk')):
            self.assertFalse(await self.scheduler.tick())
        self.assertEqual(self.protocol.sent,[]); self.assertTrue(self.scheduler.status()['blocked'])

    async def test_zero_receipt_is_uncertain_and_history_can_only_confirm_presence(self):
        async def zero(*args):
            return {'message_id':0}
        self.protocol.send = zero
        await self.scheduler.tick(); self.at += 31
        entry = next(iter(self.scheduler.status()['deliveries'].values()))
        self.protocol.history = [{'message_id':99,'user_id':10,'time':self.at-30,'message':entry['text']}]
        await self.scheduler.tick(); await self.scheduler.tick()
        self.assertEqual(next(iter(self.scheduler.status()['deliveries'].values()))['messageId'],'99')
        self.assertEqual(len(self.memory.get('g100')),1)

    async def test_cancelled_send_stays_uncertain_on_restart(self):
        started = asyncio.Event()
        async def send(*args):
            self.protocol.sent.append(args); started.set(); await asyncio.Event().wait()
        self.protocol.send = send
        task = asyncio.create_task(self.scheduler.tick())
        await started.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        other = ScheduledCommands(self.config,self.protocol,self.commands,self.memory,self.settings,now=lambda:self.at)
        self.at += 31; await other.tick(); await other.close()
        self.assertEqual(len(self.protocol.sent),1)
        self.assertEqual(next(iter(other.status()['deliveries'].values()))['status'],'uncertain')

    async def test_confirmed_receipt_disk_failure_blocks_future_sends_and_never_claims_success(self):
        import koukou.scheduled as module
        original = module.write_json
        def save(file,value):
            if any(e.get('status') == 'sent' for e in value['deliveries'].values()):
                raise OSError('disk unavailable')
            return original(file,value)
        with patch.object(module,'write_json',save):
            self.assertFalse(await self.scheduler.tick())
        await self.scheduler.tick()
        self.assertEqual(len(self.protocol.sent),1); self.assertTrue(self.scheduler.status()['blocked'])
        self.assertEqual(next(iter(self.scheduler.status()['deliveries'].values()))['status'],'uncertain')
        self.assertEqual(self.memory.get('g100'),[])

    async def test_account_change_during_probe_or_late_similar_history_cannot_confirm_wrong_account(self):
        self.protocol.probe = lambda:setattr(self.protocol,'self_id','99')
        await self.scheduler.tick(); self.assertEqual(self.protocol.sent,[])
        entry = {'selfId':'10','groupId':100,'text':'same','attemptAt':self.at*1000}
        self.protocol.history = [{'message_id':1,'user_id':10,'time':self.at+600,'message':'same'}]
        self.assertEqual((await verify_delivery(self.protocol,entry))['status'],'unknown')
        self.protocol.self_id = '10'
        self.assertEqual((await verify_delivery(self.protocol,entry))['status'],'unknown')


class DailyPingTests(SchedulerFixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.config.values.update({'DAILY_PING_ENABLED':'1','DAILY_PING_TIME':'00:00','DAILY_PING_GROUP':'100','DAILY_PING_TARGET':'20','DAILY_PING_TEXT':'/今日猪猪','DAILY_PING_CHAIN_ENABLED':'1','DAILY_PING_CHAIN_TEXT':'/我的猪圈'})
        async def pause(seconds):
            pass
        self.daily = DailyPing(self.config,self.protocol,self.memory,self.settings,rate_limiter=self.rate,now=lambda:self.at,pause=pause,rand=lambda:0)
        self.addAsyncCleanup(self.daily.close)

    def event(self,text,**extra):
        event = {'group_id':100,'user_id':20,'time':self.at,'message':text,**extra}
        self.protocol.timeline.receive(event)
        return event

    async def test_midnight_buffer_and_one_per_day_receipts(self):
        self.at = datetime.fromisoformat('2026-10-25T00:00:09+08:00').timestamp()
        await self.daily.tick(); self.assertEqual(self.protocol.sent,[])
        self.at += 1; await self.daily.tick(); await self.daily.tick()
        self.assertEqual(len(self.protocol.sent),1)
        self.assertEqual(self.protocol.sent[0][1][0],{'type':'at','data':{'qq':'20'}})
        self.assertIn('尚未确认抽取成功',self.daily.today_note('g100'))
        other = DailyPing(self.config,self.protocol,self.memory,self.settings,now=lambda:self.at)
        await other.tick(); await other.close(); self.assertEqual(len(self.protocol.sent),1)

    async def test_confirmed_target_response_chains_once_and_tracks_real_count(self):
        await self.daily.tick()
        wrong = self.event([{'type':'at','data':{'qq':'30'}},{'type':'text','data':{'text':'抓到一只新猪猪【小猪】'}}])
        self.assertFalse(await self.daily.note_message(wrong))
        event = self.event([{'type':'at','data':{'qq':'10'}},{'type':'text','data':{'text':'抓到一只新猪猪【小猪】'}}])
        self.assertTrue(await self.daily.note_message(event)); self.assertFalse(await self.daily.note_message(event))
        await self.daily.follow_task
        self.assertEqual(len(self.protocol.sent),2)
        self.assertIn('第一次获得',self.daily.today_note('g100')); self.assertIn('查过',self.daily.today_note('g100'))

    async def test_chain_change_quiet_memory_reset_or_account_change_cancels_followup(self):
        for change in [lambda:self.config.values.update(DAILY_PING_CHAIN_TEXT='/改变'),lambda:self.settings.update({'g100':{'quietHours':'00:00-01:00'}}),lambda:self.memory.clear('g100'),lambda:setattr(self.protocol,'self_id','99')]:
            self.config.values['DAILY_PING_CHAIN_TEXT'] = '/我的猪圈'; self.settings.clear(); self.protocol.self_id = '10'
            await self.daily.send_now()
            async def pause(seconds):
                change()
            self.daily.pause = pause
            event = self.event('抓到一只新猪猪【小猪】')
            await self.daily.note_message(event)
            if self.daily.follow_task:
                await self.daily.follow_task
        self.assertEqual(len(self.protocol.sent),4)

    async def test_unknown_main_cannot_chain_or_retry_and_no_catchup_after_three_hours(self):
        self.protocol.error = OneBotError('send timeout',outcome_unknown=True)
        await self.daily.tick(); self.assertIsNone(self.daily.pending_chain)
        self.at += 61; self.protocol.error = None; await self.daily.tick()
        self.assertEqual(len(self.protocol.sent),1)
        self.at += 10800; await self.daily.tick(); self.assertEqual(len(self.protocol.sent),1)

    async def test_dynamic_enabled_switch_and_quiet_consumption(self):
        self.config.values['DAILY_PING_ENABLED'] = '0'; await self.daily.tick(); self.assertEqual(self.protocol.sent,[])
        self.config.values['DAILY_PING_ENABLED'] = '1'; self.settings['g100'] = {'quietHours':'00:00-00:02'}
        await self.daily.tick(); self.at += 120; await self.daily.tick(); self.assertEqual(self.protocol.sent,[])

    async def test_reply_to_another_request_and_historical_success_cannot_claim_pig(self):
        await self.daily.tick()
        event = self.event([{'type':'reply','data':{'id':'999'}},{'type':'text','data':{'text':'抓到一只新猪猪【小猪】'}}])
        self.assertFalse(await self.daily.note_message(event))
        event = self.event('抓到一只新猪猪【小猪】',time=self.at-200)
        self.assertFalse(await self.daily.note_message(event)); self.assertNotIn('已确认抽到',self.daily.today_note('g100'))

    async def test_custom_regex_isolated_and_bad_pattern_falls_back(self):
        self.assertTrue(await chain_matches('完成[0-9]+次','完成12次'))
        self.assertTrue(await chain_matches('[invalid','抓到一只新猪猪'))
        self.assertEqual(daily_ping_target('24:00',self.at),None)
