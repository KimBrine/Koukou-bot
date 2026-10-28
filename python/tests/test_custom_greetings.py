import asyncio
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import tempfile
import time
import unittest
from koukou.admin import Admin
from koukou.bot import Bot
from koukou.config import Config
from koukou.custom import CustomCommands, clean, render_reply, scope_allows
from koukou.greetings import GreetingLibrary
from koukou.memory import Memory, LongMemory
from koukou.messages import Timeline
from koukou.onebot import OneBot, OneBotError
from koukou.plugins import PluginManager
from koukou.quiet_greetings import QuietGreetings, greeting_window
from koukou.state import read_json, write_json
import test_native_bot as fixtures


class CustomTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixtures.BotTests.asyncSetUp(self)
        self.plugins = PluginManager(self.temp.name, self.config)
        self.bot = Bot(self.config, self.bot.onebot, self.memory, model=self.bot.model, plugins=self.plugins)
        self.rules = self.bot.custom

    event = fixtures.BotTests.event
    asyncTearDown = fixtures.BotTests.asyncTearDown

    async def test_literal_alias_args_permissions_and_help(self):
        self.rules.upsert({'name': '问候', 'trigger': '/hi', 'aliases': ['/你好'], 'match': 'prefix', 'reply': '{name}，参数是{args}', 'adminOnly': True})
        await self.bot.handle(self.event('/你好 早呀', private=True))
        self.assertEqual(self.output[-1], '你，参数是早呀')
        await self.bot.handle(self.event('/help', id=2, private=True))
        self.assertIn('/hi', self.output[-1])
        self.output.clear()
        event = self.event('/hi', id=3, private=True); event['user_id'] = 200000099
        self.config.values['PRIVATE_WHITELIST'] += ',200000099'
        await self.bot.handle(event)
        self.assertFalse(self.output)

    async def test_disabled_literal_consumes_without_model_fallback(self):
        self.rules.upsert({'trigger': '/hi', 'reply': '关闭', 'enabled': False})
        await self.bot.handle(self.event('/hi', private=True))
        self.assertFalse(self.output)

    async def test_cooldown_only_after_confirmed_send(self):
        self.rules.upsert({'trigger': '/hi', 'reply': '回应', 'cooldownSec': 60})
        original = self.bot.onebot.send
        async def uncertain(*args): return {}
        self.bot.onebot.send = uncertain
        await self.bot.handle(self.event('/hi', private=True))
        self.bot.onebot.send = original
        await self.bot.handle(self.event('/hi', id=2, private=True))
        await self.bot.handle(self.event('/hi', id=3, private=True))
        self.assertEqual(self.output, ['回应'])

    async def test_ai_rule_change_during_generation_discards_output(self):
        rule = self.rules.upsert({'trigger': '/hi', 'responseMode': 'ai', 'aiPrompt': '帮忙解释'})
        outer = self
        class Model:
            async def chat(self, *args, **kwargs):
                outer.rules.upsert({**rule, 'enabled': False})
                return '迟到回答'
        self.bot.model = Model()
        await self.bot.handle(self.event('/hi', private=True))
        self.assertFalse(self.output)

    async def test_exports_redact_groups_and_import_disables_rules(self):
        admin = Admin(self.config, self.plugins, self.memory, LongMemory(self.config.data_dir))
        admin.save_custom({'trigger': '/hi', 'reply': '回应', 'scope': 'group', 'groups': [200000002], 'scheduleEnabled': True, 'scheduleTimes': ['23:00'], 'scheduleGroups': [200000002]})
        pack = admin.export_commands({})
        self.assertEqual(pack['commands'][0]['groups'], [])
        self.assertEqual(pack['commands'][0]['scheduleGroups'], [])
        pack['builtins'] = []
        admin.import_commands({'content': json.dumps(pack)})
        imported = admin.custom.all()[-1]
        self.assertFalse(imported['enabled']); self.assertFalse(imported['scheduleEnabled'])
        with self.assertRaises(ValueError): admin.save_custom({'trigger': '/help', 'reply': '冲突'})

    async def test_template_scope_and_due_windows(self):
        at = datetime(2026, 1, 2, 23, 0).timestamp()
        self.rules.upsert({'trigger': '/hi', 'reply': '定时', 'scope': 'group', 'groups': [100], 'scheduleEnabled': True, 'scheduleTimes': ['23:00'], 'scheduleGroups': [100, 200]})
        self.assertEqual([v['groupId'] for v in self.rules.due(at)], [100])
        self.assertEqual(self.rules.due(at+301), [])
        self.assertEqual(render_reply('{name}:{qq}:{args}:{unknown}', {'name': '甲', 'userId': 11, 'args': '参数'}), '甲:11:参数:{unknown}')

    async def test_notice_fixed_reply_never_pokes_back_or_uses_model(self):
        class NoModel:
            async def chat(self, *args, **kwargs): raise AssertionError('固定拍一拍不能调用模型')
        self.bot.model = NoModel()
        event = {'post_type': 'notice', 'notice_type': 'notify', 'sub_type': 'poke', 'group_id': 200000002, 'user_id': 200000011,
                 'target_id': self.bot.onebot.self_id, 'time': time.time(), 'sender': {'nickname': '群友'}}
        self.timeline.receive(event)
        await self.bot.handle(event); await self.bot.handle(event)
        self.assertEqual(len(self.output), 1)
        self.assertFalse(self.calls)
        self.output.clear(); event['target_id'] = 200000099
        await self.bot.handle(event)
        self.assertFalse(self.output)


class GreetingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.config = Config(self.root, environ={'WHITELIST_GROUPS': '100', 'QUIET_HOURS': '23:00-07:00', 'QUIET_GREETINGS_ENABLED': '1'})
        self.memory = Memory(self.config.data_dir); self.settings = {}
        self.library = GreetingLibrary(self.config.data_dir / 'persona-greetings.json')
        self.library.set(self.config.persona(), {'goodmorning': ['早上好', '早呀'], 'goodnight': ['静谧时段到了，大家晚安', '该安静休息啦，晚安']})
        self.now = datetime(2026, 1, 1, 22, 59, 55, tzinfo=timezone(timedelta(hours=8))).timestamp()*1000
        self.sent = []
        outer = self
        class Protocol:
            self_id = '10'; online = True; account_version = 0
            timeline = Timeline()
            def status(self): return {'online': self.online, 'probeVerified': self.online}
            async def send(self, key, text): outer.sent.append((key, text)); return {'message_id': len(outer.sent)}
        self.protocol = Protocol(); self.protocol.timeline.begin()
        self.scheduler = QuietGreetings(self.config, self.protocol, self.memory, self.settings, self.library, now=lambda: self.now, rand=lambda: 0, gap=0)

    async def asyncTearDown(self): self.temp.cleanup()

    async def test_night_exact_boundary_morning_online_and_no_duplicates(self):
        await self.scheduler.tick(); self.now += 5000; await self.scheduler.tick(); await self.scheduler.tick()
        self.assertEqual(len(self.sent), 1); self.assertIn('晚安', self.sent[0][1])
        self.now += 8*3600000; await self.scheduler.tick(); await self.scheduler.tick()
        self.assertEqual(len(self.sent), 2); self.assertIn('早', self.sent[1][1])

    async def test_midnight_login_no_night_and_morning_independent(self):
        self.protocol.online = False; await self.scheduler.tick()
        self.now += 10000; self.protocol.online = True; self.protocol.timeline.begin()
        await self.scheduler.tick()
        self.assertFalse(self.sent)
        self.now += 9*3600000; self.protocol.online = False; await self.scheduler.tick()
        self.now += 3600000; self.protocol.online = True; self.protocol.timeline.begin()
        await self.scheduler.tick()
        self.assertEqual(len(self.sent), 1); self.assertIn('早', self.sent[0][1])

    async def test_restart_during_quiet_does_not_resend_goodnight(self):
        await self.scheduler.tick(); self.now += 5000; await self.scheduler.tick()
        self.assertEqual(len(self.sent), 1)
        restored = QuietGreetings(self.config, self.protocol, self.memory, self.settings, self.library, now=lambda: self.now, gap=0)
        self.now += 1000; await restored.tick()
        self.assertEqual(len(self.sent), 1)

    async def test_missing_receipt_never_retries_and_new_persona_does_not_mix(self):
        async def unknown(key, text): self.sent.append((key, text)); return {}
        self.protocol.send = unknown
        await self.scheduler.tick(); self.now += 5000; await self.scheduler.tick(); await self.scheduler.tick()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(next(iter(self.scheduler.state['deliveries'].values()))['status'], 'uncertain')
        self.settings['g100'] = {'persona': '新人格'}
        directory = self.config.data_dir / 'personas'; directory.mkdir(); (directory / '新人格.txt').write_text('新人格正文', encoding='utf-8')
        self.now += 8*3600000; await self.scheduler.tick()
        self.assertEqual(len(self.sent), 1)

    async def test_muted_group_and_changed_schedule_do_not_send(self):
        await self.scheduler.tick(); self.config.values['MUTED_GROUPS'] = '100'; self.now += 5000; await self.scheduler.tick()
        self.assertFalse(self.sent)
        self.config.values['MUTED_GROUPS'] = ''; self.settings['g100'] = {'quietHours': '22:00-06:00'}
        await self.scheduler.tick()
        self.assertFalse(self.sent)


class AccountTests(unittest.IsolatedAsyncioTestCase):
    async def test_account_change_invalidates_pending_action_and_old_probe(self):
        class Socket:
            closed = False
            async def send_json(self, value): pass
        bot = OneBot('ws://example.invalid'); bot.ws = Socket(); bot.self_id = '10'; bot.online = True; bot.timeline.begin()
        future = asyncio.get_running_loop().create_future(); bot.pending['a'] = (bot.ws, future)
        bot.schedule_probe = lambda: None
        bot.receive({'post_type': 'notice', 'self_id': 20, 'user_id': 1, 'time': time.time()}, bot.ws)
        self.assertFalse(bot.online); self.assertFalse(bot.timeline.available)
        with self.assertRaises(OneBotError): future.result()
        self.assertEqual(bot.self_id, '20')

    async def test_wire_text_is_not_interpreted_as_cq_action(self):
        bot = OneBot('ws://example.invalid'); calls = []
        async def api(action, params, **kwargs): calls.append(params); return {'message_id': 1}
        bot.api = api
        await bot.send('g100', '[CQ:at,qq=all]')
        self.assertEqual(calls[0]['message'][0]['type'], 'text')


if __name__ == '__main__': unittest.main()
