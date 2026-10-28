import asyncio
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from koukou.actions import Actions
from koukou.bot import Bot
from koukou.commands import CommandRegistry
from koukou.config import Config
from koukou.duration import parse_duration
from koukou.media import MediaDelivery, local_path
from koukou.memory import Memory
from koukou.messages import Timeline, parse_message
from koukou.onebot import OneBotError
from koukou.plugins import PluginManager


class ActionsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(self.temp.name, environ={"BOT_DATA_DIR": self.temp.name, "ADMIN_USERS": "11", "WHITELIST_GROUPS": "100"})
        self.plugins = PluginManager(self.temp.name, self.config)
        self.registry = CommandRegistry(self.config, self.plugins)
        for id in ["owner-mute", "self-mute", "self-recall", "whole-mute"]:
            self.registry.save_builtin({"id": id, "enabled": True, "scope": "group", "groups": [100]})
        self.registry.save_builtin({"id": "request-poke", "enabled": True})
        self.timeline = Timeline(); self.timeline.begin()
        self.calls, self.replies, self.outputs = [], [], []
        self.roles = {10: "admin", 11: "admin", 12: "member", 13: "owner", 14: "admin"}
        outer = self
        class Protocol:
            self_id = "10"
            timeline = outer.timeline
            async def api(self, action, params, **kwargs):
                if action == 'get_group_member_info':
                    uid = params['user_id']
                    return {"user_id": uid, "role": outer.roles[uid], "nickname": "群友"+str(uid)}
                outer.calls.append((action, params))
                return {}
        class Model:
            async def chat(self, *args, **kwargs):
                value=outer.outputs.pop(0)
                if isinstance(value,dict):value={'confidence':.99,'executor':'bot',**value}
                return json.dumps(value)
        self.protocol = Protocol()
        self.actions = Actions(self.config, self.protocol, self.registry, Model())
        self.seq = 0

    async def asyncTearDown(self):
        self.temp.cleanup()

    def event(self, text, actor=11, mention=12, quote=None, at=True):
        self.seq += 1
        message = [{"type": "text", "data": {"text": text}}]
        if at: message.insert(0, {"type": "at", "data": {"qq": "10"}})
        if mention: message.append({"type": "at", "data": {"qq": str(mention)}})
        if quote: message.append({"type": "reply", "data": {"id": str(quote)}})
        event = {"group_id": 100, "user_id": actor, "message_id": self.seq, "message_type": "group", "post_type": "message", "message": message, "time": time.time()}
        self.timeline.receive(event)
        return event

    async def handle(self, event, result, quote=None, current=lambda: True):
        followup = self.actions.reserve(event)
        parsed = parse_message(event['message'], '10')
        self.actions.observe(event, parsed, quote)
        self.outputs.append(result)
        async def reply(text): self.replies.append(text); return True
        return await self.actions.handle(event, parsed, followup=followup, quote=quote, current=current, reply=reply)

    async def test_owner_or_bot_admin_with_actual_group_admin_only(self):
        result = {"intent": "mute", "targets": [{"id": "12", "evidence": "mention"}], "duration": "60s"}
        for actor in [11, 13, 14, 12]:
            self.calls.clear()
            await self.handle(self.event('禁言他60s', actor=actor), result)
            self.assertEqual(bool(self.calls), actor in {11, 13}, actor)
        self.roles[10] = 'member'; self.calls.clear()
        await self.handle(self.event('禁言他60s'), result)
        self.assertFalse(self.calls)

    async def test_self_mute_math_and_target_role_guard(self):
        result = {"intent": "self_mute", "targets": [], "duration": "(20+40)秒"}
        await self.handle(self.event('禁言我(20+40)秒', actor=12, mention=None), result)
        self.assertEqual(self.calls[-1], ('set_group_ban', {'group_id': 100, 'user_id': 12, 'duration': 60}))
        self.calls.clear()
        await self.handle(self.event('禁言我(20+40)秒', actor=13, mention=None), result)
        self.assertFalse(self.calls)
        with self.assertRaises(ValueError): parse_duration('10分钟或20分钟')
        self.assertTrue(parse_duration('31天')['overLimit'])

    async def test_short_mute_incomplete_duration_and_whole_schedule_never_dispatch(self):
        for text,result in [
            ('禁言他1秒',{'intent':'mute','targets':[{'id':'12','evidence':'mention'}],'duration':'1秒'}),
            ('禁言他十分钟',{'intent':'mute','targets':[{'id':'12','evidence':'mention'}],'duration':None}),
            ('全员禁言十分钟',{'intent':'whole_enable','targets':[],'duration':None}),
            ('每天晚上全员禁言',{'intent':'whole_enable','targets':[],'duration':None}),
            ('禁言他一分钟',{'intent':'unmute','targets':[{'id':'12','evidence':'mention'}]}),
        ]:
            await self.handle(self.event(text),result)
            self.assertFalse(self.calls,text)

    async def test_self_mute_label_cannot_replace_self_consent(self):
        result={'intent':'self_mute','targets':[],'duration':'一分钟'}
        for text,mention in [('帮我禁言他一分钟',None),('禁言我一分钟',14),('我知道他被禁言一分钟了',None)]:
            await self.handle(self.event(text,actor=12,mention=mention),result)
            self.assertFalse(self.calls,text)
        await self.handle(self.event('我想被禁言一分钟',actor=12,mention=None),result)
        self.assertEqual(self.calls[-1][1]['user_id'],12)
        self.calls.clear()
        await self.handle(self.event('禁言本喵一分钟',actor=12,mention=None),result)
        self.assertEqual(self.calls[-1][1]['duration'],60)

    async def test_first_clarification_preserves_original_action_and_duration(self):
        await self.handle(self.event('把他禁言十分钟',mention=None),{'intent':'mute','targets':[],'duration':'十分钟'})
        await self.handle(self.event('这位',mention=12,at=False),{'intent':'mute','targets':[{'id':'12','evidence':'mention'}],'duration':None})
        self.assertEqual(self.calls[-1][1]['duration'],600)
        self.calls.clear()
        await self.handle(self.event('把他禁言',mention=None),{'intent':'mute','targets':[],'duration':None})
        await self.handle(self.event('解禁这位',mention=12,at=False),{'intent':'unmute','targets':[{'id':'12','evidence':'mention'}]})
        self.assertFalse(self.calls)

    async def test_recall_requires_correct_quoted_message_and_actual_author_permission(self):
        result = {"intent": "recall", "targets": []}
        quote = {'group_id': 100, 'message_id': 99, 'user_id': 12, 'message_type': 'group'}
        await self.handle(self.event('帮我撤回', actor=12, mention=None, quote=99), result, quote)
        self.assertEqual(self.calls[-1], ('delete_msg', {'message_id': '99'}))
        self.calls.clear()
        await self.handle(self.event('帮我撤回', actor=14, mention=None, quote=99), result, quote)
        self.assertFalse(self.calls)
        await self.handle(self.event('帮我撤回', actor=13, mention=None, quote=99), result, quote)
        self.assertEqual(self.calls[-1][0], 'delete_msg')
        self.calls.clear(); bad = {**quote, 'message_id': 98}
        await self.handle(self.event('帮我撤回', mention=None, quote=99), result, bad)
        self.assertFalse(self.calls)

    async def test_first_followup_only_and_unrelated_user_does_not_consume(self):
        await self.handle(self.event('把他禁了', mention=None), {"intent": "mute", "targets": [], "duration": None})
        self.assertTrue(self.actions.pending)
        unrelated = self.event('插话', actor=12, mention=None, at=False)
        self.assertIsNone(self.actions.reserve(unrelated)); self.assertTrue(self.actions.pending)
        followup = self.event('这位', mention=12, at=False)
        await self.handle(followup, {"intent": "mute", "targets": [{"id": "12", "evidence": "mention"}], "duration": None})
        self.assertEqual(len(self.calls), 1); self.assertFalse(self.actions.pending)
        self.assertIsNone(self.actions.reserve(self.event('再补一句', mention=12, at=False)))

    async def test_quote_receipt_and_executor_are_required_before_any_action(self):
        for quote in [{'group_id':100,'user_id':12,'message_type':'group'},
                      {'group_id':100,'user_id':12,'message_id':99}]:
            await self.handle(self.event('帮我撤回',actor=12,mention=None,quote=99),{'intent':'recall','targets':[]},quote)
            self.assertFalse(self.calls)
            self.actions.pending.clear()
        await self.handle(self.event('让群友戳机器人'),{'intent':'poke','executor':'other','targets':[{'id':'12','evidence':'mention'}]})
        self.assertFalse(self.calls)
        for confidence in [None,.89,True,float('nan')]:
            await self.handle(self.event('禁言他一分钟'),{'intent':'mute','confidence':confidence,'targets':[{'id':'12','evidence':'mention'}],'duration':'一分钟'})
            self.assertFalse(self.calls)
            self.actions.pending.clear()

    async def test_third_party_poke_hallucinated_targets_and_policy_change(self):
        await self.handle(self.event('让别人戳机器人', mention=12), {"intent": "none"})
        self.assertFalse(self.calls)
        await self.handle(self.event('拍那位', mention=None), {"intent": "poke", "targets": [{"id": "99", "evidence": "recent"}]})
        self.assertFalse(self.calls)
        self.actions.pending.clear()
        await self.handle(self.event('拍拍他'), {"intent": "poke", "targets": [{"id": "12", "evidence": "mention"}]}, current=lambda: False)
        self.assertFalse(self.calls)

    async def test_one_delivery_per_request_and_uncertain_actions_never_retry(self):
        event = self.event('禁言他60s')
        result = {"intent": "mute", "targets": [{"id": "12", "evidence": "mention"}], "duration": "60s"}
        original = self.protocol.api
        async def uncertain(action, params, **kwargs):
            if action == 'set_group_ban':
                self.calls.append((action, params)); raise OneBotError('timeout', outcome_unknown=True)
            return await original(action, params, **kwargs)
        self.protocol.api = uncertain
        await self.handle(event, result); await self.handle(event, result)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(next(iter(self.actions.deliveries.values()))['status'], 'uncertain')

    async def test_malformed_model_and_revoked_policy_do_not_execute(self):
        for result in [[], None, 'mute']:
            await self.handle(self.event('禁言他60s'), result)
        self.assertFalse(self.calls)
        outer = self
        class ChangedModel:
            async def chat(self, *args, **kwargs):
                outer.registry.save_builtin({'id': 'owner-mute', 'enabled': False, 'scope': 'group', 'groups': [100]})
                return json.dumps({'intent': 'mute', 'targets': [{'id': '12', 'evidence': 'mention'}], 'duration': '60s'})
        self.actions.model = ChangedModel()
        await self.handle(self.event('禁言他60s'), {})
        self.assertFalse(self.calls)

    async def test_session_change_discards_pending_clarification(self):
        await self.handle(self.event('把他禁了', mention=None), {'intent': 'mute', 'targets': []})
        self.assertTrue(self.actions.pending)
        self.timeline.begin()
        self.assertIsNone(self.actions.reserve(self.event('这位', at=False)))
        self.assertFalse(self.actions.pending)

    async def test_bot_routes_management_and_quiet_blocks_execution(self):
        async def send(key, text, **kwargs):
            self.replies.append(text)
            return {'message_id': 300}
        self.protocol.send = send
        bot = Bot(self.config, self.protocol, Memory(self.config.data_dir), plugins=self.plugins, model=self.actions.model)
        self.outputs.append({'intent': 'mute', 'targets': [{'id': '12', 'evidence': 'mention'}], 'duration': '60s'})
        await bot.handle(self.event('禁言他60s'))
        self.assertEqual(self.calls[-1][0], 'set_group_ban')
        self.calls.clear(); bot.quiet = lambda key: True
        await bot.handle(self.event('禁言他60s'))
        self.assertFalse(self.calls)

    async def test_imported_management_policy_cannot_expand_to_all_groups(self):
        rule = {**self.registry.get('owner-mute'), 'scope': 'all'}
        self.assertFalse(self.registry.allowed(rule, self.event('禁言他')))


class MediaPathTests(unittest.TestCase):
    def test_file_uri_roundtrip_preserves_literal_percent_and_unicode_names(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ['literal%20.txt','literal%23.txt','literal%25.txt','中文 文件%20%23%25.txt']:
                with self.subTest(name=name):
                    expected=Path(directory)/name
                    expected.write_text('generic file fixture',encoding='utf-8')
                    self.assertEqual(local_path(expected.as_uri()),expected.resolve())
                    self.assertEqual(local_path(str(expected)),expected.resolve())

    def test_file_selection_does_not_upload_a_decoded_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Config(directory,environ={})
            wanted=Path(directory)/'literal%20.txt'
            collision=Path(directory)/'literal .txt'
            wanted.write_text('selected fixture',encoding='utf-8')
            collision.write_text('different file',encoding='utf-8')
            media=MediaDelivery(config,object())
            files,_=media.files({'files':[wanted.as_uri()]})
            self.assertEqual(files[0]['path'],wanted.resolve())
            self.assertEqual(files[0]['path'].read_text(encoding='utf-8'),'selected fixture')


class MediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(self.temp.name, environ={"BOT_DATA_DIR": self.temp.name})
        self.sent, self.api, self.fail = [], [], None
        outer = self
        class Protocol:
            self_id = '10'
            async def send(self, key, message, **kwargs):
                outer.sent.append((key, message, kwargs))
                if outer.fail: raise outer.fail
                return {'message_id': len(outer.sent)}
            async def api(self, action, params, **kwargs):
                outer.api.append((action, params, kwargs)); return {'message_id': 99}
        self.protocol = Protocol()
        self.media = MediaDelivery(self.config, self.protocol)
        self.event = {'group_id': 100, 'user_id': 11, 'message_id': 1}
        self.path = Path(self.temp.name) / '测试 文件.zip'; self.path.write_bytes(b'archive')

    async def asyncTearDown(self): self.temp.cleanup()

    async def test_sdk_file_and_recall_confirmed_id_only(self):
        result = {'text': '文件来了', 'files': [str(self.path)]}
        receipts = await self.media.deliver(self.event, result)
        self.assertEqual(len(receipts), 2); self.assertEqual(self.sent[-1][2]['timeout'], 600)
        record = next(r for r in self.media.records.values() if r.get('recallStatus') == 'pending')
        record['recallAt'] = 0; await self.media.cleanup()
        self.assertEqual(self.api[-1][0], 'delete_msg')
        await self.media.deliver(self.event, result); self.assertEqual(len(self.sent), 2)

    async def test_invalid_file_before_text_and_quiet_blocks_delivery(self):
        with self.assertRaises(ValueError):
            await self.media.deliver(self.event, {'text': '不能先发', 'files': [str(self.path)+'missing']})
        self.assertFalse(self.sent)

    async def test_invalid_card_and_recall_time_cannot_partially_send_text(self):
        for card in [{'nodes': []}, {'nodes': [None]}, {'nodes': [{'images': ['missing.png']}]}]:
            with self.assertRaises(ValueError):
                await self.media.deliver(self.event, {'text': '不应发送', 'legacyCard': card})
        with self.assertRaises(ValueError):
            await self.media.deliver(self.event, {'text': '不应发送', 'legacyFile': {'path': str(self.path), 'recall_minutes': None}})
        self.assertFalse(self.sent)
        self.media.quiet = lambda key: True
        self.assertFalse(await self.media.deliver(self.event, {'text': '晚间请求'}))
        self.assertFalse(self.sent)

    async def test_explicit_unsupported_only_falls_back_but_timeout_does_not(self):
        self.fail = OneBotError('unsupported file segment')
        await self.media.deliver(self.event, {'files': [str(self.path)]})
        self.assertEqual(self.api[-1][0], 'upload_group_file')
        self.assertEqual(self.api[-1][2]['timeout'], 600)
        self.api.clear(); self.event['message_id'] = 2
        self.fail = OneBotError('timeout', outcome_unknown=True)
        with self.assertRaises(OneBotError):
            await self.media.deliver(self.event, {'files': [str(self.path)]})
        self.assertFalse(self.api)

    async def test_unknown_receipt_stops_later_parts_and_card_payload(self):
        async def unknown(*args, **kwargs): self.sent.append(args); return {}
        self.protocol.send = unknown
        await self.media.deliver(self.event, {'text': '文字', 'files': [str(self.path)]})
        self.assertEqual(len(self.sent), 1)
        self.event['message_id'] = 2
        await self.media.deliver(self.event, {'legacyCard': {'nodes': [{'text': '一段内容', 'images': ['https://example.invalid/image.png']}]}})
        self.assertEqual(self.api[-1][0], 'send_group_forward_msg')
        self.assertEqual(self.api[-1][2]['timeout'], 120)


if __name__ == '__main__': unittest.main()
