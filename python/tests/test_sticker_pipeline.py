import asyncio
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from koukou.config import Config
from koukou.memory import Memory
from koukou.messages import Timeline
from koukou.image_cache import ImageCache
from koukou.rate_limit import RateLimiter
from koukou.sticker_learn import StickerLearner
from koukou.sticker_policy import StickerPolicy, user_asks_for_sticker
from koukou.stickers import StickerStore, PersonaStickers, candidate_weights
import test_native_bot as fixtures


def picture(index=0):
    return 'data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\n'+bytes([index])*1100).decode()


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StickerStore(Path(self.tmp.name)/'stickers')

    def tearDown(self):
        self.tmp.cleanup()

    def test_duplicate_names_weighted_equally_regardless_usage_order(self):
        a = self.store.add({'dataUrl': picture(1), 'name': '开心', 'keywords':['高兴']})['item']
        b = self.store.add({'dataUrl': picture(2), 'name': '开心', 'keywords':['高兴']})['item']
        a['usage'], b['usage'] = 999, 0
        pool = candidate_weights([a,b], ['开心'])
        self.assertEqual([v['weight'] for v in pool], [1.7,1.7])
        self.assertEqual(self.store.choose(['开心'], rand=lambda: .99)[0]['id'], b['id'])
        self.assertEqual(self.store.choose(['高兴'], rand=lambda: 0)[0]['id'], a['id'])

    def test_blacklist_survives_restart_and_preserves_preview(self):
        item = self.store.add({'dataUrl':picture(), 'name':'图'})['item']
        self.store.blacklist(item['id'])
        store = StickerStore(self.store.dir)
        self.assertFalse(store.items)
        self.assertIsNotNone(store.blacklist_image(item['hash']))
        with self.assertRaises(ValueError):
            store.add({'dataUrl':picture()})
        store.unblock(item['hash'])
        self.assertFalse(store.items)
        store.add({'dataUrl':picture()})

    def test_capacity_requires_manual_cleanup_and_explicit_resume(self):
        for i in range(60):
            self.store.add({'dataUrl':picture(i)})
        self.assertFalse(self.store.learning_allowed())
        with self.assertRaises(ValueError):
            self.store.add({'dataUrl':picture(61)})
        self.store.remove(self.store.items[0]['id'])
        reloaded = StickerStore(self.store.dir)
        self.assertFalse(reloaded.learning_allowed())
        reloaded.resume_learning()
        self.assertTrue(reloaded.learning_allowed())

    def test_explicit_request_excludes_discussion_and_negation(self):
        for text in ['给我发张开心的表情包', '来张贴纸', '请联网搜一张表情包']:
            self.assertTrue(user_asks_for_sticker(text), text)
        for text in ['不要发表情包', '分析这张图片', '为什么要发表情包', '[索要表情包]']:
            self.assertFalse(user_asks_for_sticker(text), text)


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.BotTests.asyncSetUp
    asyncTearDown = fixtures.BotTests.asyncTearDown
    event = fixtures.BotTests.event

    async def test_paragraph_lottery_once_and_usage_after_image_receipt(self):
        self.config.values.update(STICKER_AUTO_RATE='35', STICKERS_ENABLED='1')
        store = self.bot.stickers.for_chat('g200000002')
        item = store.add({'dataUrl': picture(), 'name':'开心'})['item']
        rolls = []
        self.bot.sticker_policy.rand = lambda: rolls.append(1) or .2
        selected = []
        choose = self.bot.sticker_policy.select
        def select(*args, **kwargs):
            selected.append(1)
            return choose(*args, **kwargs)
        self.bot.sticker_policy.select = select
        class Model:
            async def chat(self,*args,**kwargs):
                return '第一句完整的话。\n第二句也完整。\n[贴纸:开心]'
        self.bot.model = Model()
        await self.bot.handle(self.event('请说两句完整的话'))
        self.assertEqual(len(selected), 1)
        self.assertEqual(len(rolls), 2)  # One probability draw, one weighted candidate draw.
        self.assertTrue(isinstance(self.output[-1], list))
        self.assertEqual(item['usage'], 1)
        self.assertTrue(all(isinstance(v,str) for v in self.output[:-1]))

    async def test_text_unconfirmed_never_sends_image_or_charges_quota(self):
        self.config.values.update(STICKER_AUTO_RATE='100', STICKERS_ENABLED='1')
        store = self.bot.stickers.for_chat('g200000002')
        item = store.add({'dataUrl':picture(), 'name':'开心'})['item']
        class Model:
            async def chat(self,*args,**kwargs): return '你好。\n[贴纸:开心]'
        async def send(key, text):
            self.output.append(text); return {}
        self.bot.model, self.bot.onebot.send = Model(), send
        self.bot.rate_limiter = RateLimiter(1,0)
        await self.bot.handle(self.event())
        self.assertEqual(len(self.output),1)
        self.assertEqual(item['usage'],0)
        self.assertFalse(self.bot.rate_limiter.history)

    async def test_explicit_request_bypasses_zero_rate_but_q_does_not(self):
        self.config.values.update(STICKER_AUTO_RATE='0', STICKERS_ENABLED='1')
        item = self.bot.stickers.for_chat('p200000011').add({'dataUrl':picture(),'name':'开心'})['item']
        class Model:
            async def chat(self,*args,**kwargs): return '给你挑一张。\n[贴纸:开心]'
        self.bot.model = Model()
        await self.bot.handle(self.event('给我发张表情包', private=True))
        self.assertEqual(item['usage'],1)
        self.output.clear()
        await self.bot.handle(self.event('/Q 请分析这张表情包', private=True, id=2))
        self.assertTrue(all(isinstance(v,str) for v in self.output))
        self.assertEqual(item['usage'],1)

    async def test_blacklist_between_text_and_image_suppresses_image(self):
        self.config.values.update(STICKER_AUTO_RATE='100', STICKERS_ENABLED='1')
        store = self.bot.stickers.for_chat('g200000002')
        item = store.add({'dataUrl':picture(),'name':'开心'})['item']
        class Model:
            async def chat(self,*args,**kwargs): return '你好。\n[贴纸:开心]'
        async def send(key,text):
            self.output.append(text)
            if isinstance(text,str): store.blacklist(item['id'])
            return {'message_id':len(self.output)}
        self.bot.model, self.bot.onebot.send = Model(), send
        await self.bot.handle(self.event())
        self.assertTrue(all(isinstance(v,str) for v in self.output))

    async def test_accepted_slow_reply_survives_age_but_not_session_change(self):
        clock = [time.time()]
        self.timeline.now = lambda: clock[0]
        captured = []
        class Model:
            async def chat(self,prompt,history,**kwargs):
                captured.extend(history); clock[0] += 200
                self_model.timeline.receive(fixtures.BotTests.event(outer,'后来消息',2))
                return '仍然完整回答原问题。'
        outer, self_model = self, self.bot.onebot
        self.bot.model = Model()
        await self.bot.handle(self.event('原问题'))
        self.assertTrue(self.output)
        self.assertIn('原问题', captured[-1]['content'])
        self.assertNotIn('后来消息', captured[-1]['content'])
        self.output.clear()
        class Offline:
            async def chat(_, *args, **kwargs):
                self.timeline.end(); return '旧连接的回答'
        self.bot.model = Offline()
        event = self.event('新的问题',3)
        event['time'] = clock[0]; self.timeline.receive(event)
        await self.bot.handle(event)
        self.assertFalse(self.output)

    async def test_new_arrival_during_quote_read_cannot_replace_model_target(self):
        captured = []
        async def api(action,params):
            self.memory.push('g200000002','user','别人的新问题',messageId=99,userId='200000099')
            return {'message_id':7,'group_id':200000002,'user_id':200000010,'message':'旧回答'}
        class Model:
            async def chat(_,prompt,history,**kwargs):
                captured.extend(history); return '回答本轮。'
        self.bot.onebot.api, self.bot.model = api, Model()
        event = self.event('原问题')
        event['message'].insert(0,{'type':'reply','data':{'id':'7'}})
        await self.bot.handle(event)
        self.assertIn('原问题',captured[-1]['content'])
        self.assertNotIn('别人的新问题',json.dumps(captured,ensure_ascii=False))


class LearningTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Config(self.tmp.name,environ={'STICKER_LEARN_ENABLED':'1','STICKER_LEARN_GROUPS':'200000003','ACTIVE_PERSONA':'one'})
        self.memory = Memory(self.config.data_dir)
        self.libraries = PersonaStickers(self.config,self.memory,{})
        self.cache = ImageCache(self.config.data_dir/'image-cache')
        self.calls = []
        outer = self
        class Model:
            async def describe(self,*args,**kwargs):
                outer.calls.append(args); return '{"isSticker":true,"name":"开心","keywords":["笑"],"description":"开心时使用"}'
        class OneBot: pass
        async def fetch(*args,**kwargs):
            return base64.b64decode(picture().split(',')[1]), 'image/png'
        self.learner = StickerLearner(self.config, OneBot(), self.libraries, Model(), Model(), self.cache, fetch=fetch)

    async def asyncTearDown(self):
        await self.learner.close(); await self.cache.close(); self.tmp.cleanup()

    async def test_explicit_nonwhitelist_group_collects_dual_pass_once(self):
        image = {'url':'https://example.org/a.png'}
        self.assertIsNone(self.learner.enqueue(images=[image],chat_key='g200000002'))
        await self.learner.enqueue(images=[image],chat_key='g200000003')
        self.assertEqual(len(self.calls),2)
        await self.learner.enqueue(images=[image],chat_key='g200000003')
        self.assertEqual(len(self.calls),2)
        self.assertEqual(len(self.libraries.for_chat('g200000003').items),1)

    async def test_persona_change_during_tagging_never_saves_into_either_library(self):
        outer = self
        class Tag:
            async def describe(self,*args,**kwargs):
                outer.config.values['ACTIVE_PERSONA']='two'
                return '{"isSticker":true,"name":"开心"}'
        self.learner.tag = Tag()
        old = self.libraries.for_chat('g200000003')
        await self.learner.enqueue(images=[{'url':'https://example.org/a.png'}],chat_key='g200000003')
        self.assertFalse(old.items)
        self.assertFalse(self.libraries.for_chat('g200000003').items)


if __name__ == '__main__':
    unittest.main()
