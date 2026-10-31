import asyncio
from pathlib import Path
import tempfile
import unittest
from koukou.config import Config
from koukou.reply_behavior import ReplyBehavior, FixedReplyVariety, pacing_seconds
from koukou.state import read_json


class PacingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.config=Config(self.temp.name,environ={})

    def test_disabled_and_bounded_without_changing_text(self):
        text='完整回答，不应被截断。🙂'
        self.assertEqual(pacing_seconds(self.config,text),0)
        self.config.values.update(REPLY_PACING_ENABLED='1',REPLY_PACING_SPEED='2',REPLY_PACING_MAX_SECONDS='3')
        self.assertEqual(pacing_seconds(self.config,text),3)
        self.assertEqual(text,'完整回答，不应被截断。🙂')
        self.config.values.update(REPLY_PACING_SPEED='-1',REPLY_PACING_MAX_SECONDS='-1')
        self.assertEqual(pacing_seconds(self.config,text),0)

    def test_word_mode_counts_chinese_characters_and_english_words(self):
        self.config.values.update(REPLY_PACING_ENABLED='1',REPLY_PACING_SPEED='1',REPLY_PACING_MAX_SECONDS='60',REPLY_PACING_MODE='word')
        self.assertEqual(pacing_seconds(self.config,'你好 hello world'),4)

    def test_fixed_choices_persist_only_after_confirmation_and_isolate_personas(self):
        self.config.values['FIXED_REPLY_VARIATION_ENABLED']='1'
        a=FixedReplyVariety(self.config);scope=['one','private','persona-A'];choices=['甲','乙','丙']
        self.assertEqual(a.choose(choices,scope,rand=lambda:0),'甲')
        self.assertFalse(a.file.exists())
        a.record(scope,'甲')
        b=FixedReplyVariety(self.config)
        self.assertEqual(b.choose(choices,scope,rand=lambda:0),'乙')
        self.assertEqual(b.choose(choices,['one','private','persona-B'],rand=lambda:0),'甲')
        b.record(['other'],'丁');a.record(scope,'乙')
        self.assertEqual(len(read_json(a.file)['scopes']),2)
        a.record(scope,'丙')
        self.assertEqual(a.choose(choices,scope,rand=lambda:0),'甲')
        self.assertEqual(a.choose(['唯一'],scope),'唯一')
        self.assertEqual(a.choose([],scope),'')

    def test_disabled_variety_does_not_write(self):
        variety=FixedReplyVariety(self.config);variety.record(['a'],'b')
        self.assertFalse(variety.file.exists())


class TypingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.config=Config(self.temp.name,environ={'TYPING_STATUS_ENABLED':'1','ONEBOT_IMPLEMENTATION':'snowluma'})
        outer=self
        class Protocol:
            self_id='200000001';account_version=1;ws=object()
            async def api(self,action,params,timeout=None):
                outer.calls.append((action,params))
                if outer.failure:raise RuntimeError('optional state unavailable')
        self.calls=[];self.failure=False;self.protocol=Protocol();self.behavior=ReplyBehavior(self.config,self.protocol)

    async def test_private_start_and_final_clear(self):
        async with self.behavior.typing({'user_id':200000002}):self.assertEqual(len(self.calls),1)
        self.assertEqual([p['event_type'] for _,p in self.calls],[1,0])
        self.assertTrue(all(a=='set_input_status' for a,_ in self.calls))

    async def test_official_groups_disabled_and_unaccepted_do_not_call(self):
        for patch,event,current in [({'QQ_TRANSPORT':'qq-official'},{'user_id':2},True),
             ({'QQ_TRANSPORT':'onebot','ONEBOT_IMPLEMENTATION':'auto'},{'user_id':2},True),
             ({'ONEBOT_IMPLEMENTATION':'snowluma'},{'user_id':2,'group_id':3},True),
             ({},{'user_id':2},False),({'TYPING_STATUS_ENABLED':'0'},{'user_id':2},True)]:
            self.config.values.update(patch)
            async with self.behavior.typing(event,current=lambda:current):pass
        self.assertEqual(self.calls,[])

    async def test_failure_is_best_effort_no_content_send_and_no_repeated_probe(self):
        self.failure=True
        async with self.behavior.typing({'user_id':2}):pass
        first=len(self.calls)
        async with self.behavior.typing({'user_id':2}):pass
        self.assertEqual(len(self.calls),first)
        self.protocol.account_version+=1;self.failure=False
        async with self.behavior.typing({'user_id':2}):pass
        self.assertEqual(len(self.calls),first+2)

    async def test_concurrent_questions_share_one_indicator_until_both_finish(self):
        entered=asyncio.Event();release=asyncio.Event()
        async def second():
            async with self.behavior.typing({'user_id':2}):
                entered.set();await release.wait()
        async with self.behavior.typing({'user_id':2}):
            work=asyncio.create_task(second());await entered.wait()
        self.assertEqual([p['event_type'] for _,p in self.calls],[1])
        release.set();await work
        self.assertEqual([p['event_type'] for _,p in self.calls],[1,0])

    async def test_cancel_clears_indicator_but_account_switch_does_not_touch_new_account(self):
        async def pending():
            async with self.behavior.typing({'user_id':2}):await asyncio.Event().wait()
        work=asyncio.create_task(pending())
        while not self.calls:await asyncio.sleep(0)
        work.cancel()
        with self.assertRaises(asyncio.CancelledError):await work
        self.assertEqual(self.calls[-1][1]['event_type'],0)
        self.calls.clear()
        async with self.behavior.typing({'user_id':2}):self.protocol.account_version+=1
        self.assertEqual([p['event_type'] for _,p in self.calls],[1])


class BehaviorSettingsTests(unittest.TestCase):
    def setUp(self):
        from koukou.admin import Admin
        from koukou.memory import Memory,LongMemory
        from koukou.plugins import PluginManager
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.config=Config(self.temp.name,environ={})
        self.admin=Admin(self.config,PluginManager(self.temp.name),Memory(self.config.data_dir),LongMemory(self.config.data_dir,None))

    def test_settings_are_manual_persisted_and_bounded(self):
        self.admin.set_config_batch({'patch':{'ONEBOT_IMPLEMENTATION':'snowluma','TYPING_STATUS_ENABLED':'1','REPLY_PACING_ENABLED':'1','FIXED_REPLY_VARIATION_ENABLED':'1'}})
        restored=Config(self.temp.name,environ={})
        self.assertTrue(restored.enabled('TYPING_STATUS_ENABLED'))
        self.assertTrue(restored.enabled('FIXED_REPLY_VARIATION_ENABLED'))
        for key,value in [('REPLY_PACING_SPEED','0'),('REPLY_PACING_MAX_SECONDS','61'),('FIXED_REPLY_VARIATION_WINDOW','21'),('REPLY_PACING_MODE','bad')]:
            with self.assertRaises(ValueError):self.admin.set_config_batch({'patch':{key:value}})

    def test_official_identity_cannot_be_overwritten_and_typing_is_unavailable(self):
        self.config.values['QQ_TRANSPORT']='qq-official'
        for patch in [{'TYPING_STATUS_ENABLED':'1'},{'ONEBOT_WS_URL':'ws://127.0.0.1:3012/'},{'ONEBOT_ACCESS_TOKEN':'fixture-private-token'}]:
            with self.assertRaises(ValueError):self.admin.set_config_batch({'patch':patch})
        self.assertFalse(self.config.env_file.exists())
