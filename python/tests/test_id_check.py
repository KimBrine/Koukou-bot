import asyncio
import tempfile
import unittest

from koukou.config import Config
from koukou.id_check import IdCheck, check_name, check_members, can_kick_now, ID_CHECK_CMD_RE, ID_CHECK_KICK_CMD_RE
from koukou.messages import Timeline
from koukou.onebot import OneBotError
from koukou.state import write_json


class NameTests(unittest.TestCase):
    def test_room_boundaries_and_separate_confirmation_command(self):
        for name in ['604', '604方铁', '６０４ 方铁', '1009', '707-昵称', '60']:
            self.assertTrue(check_name(name)['ok'], name)
        for name in ['502王五', '1102赵六', '6045名字', '东d702名字', '昵称', '٦٠٤名字', '']:
            self.assertFalse(check_name(name)['ok'], name)
        self.assertTrue(ID_CHECK_CMD_RE.fullmatch('／查名片！'))
        self.assertTrue(ID_CHECK_KICK_CMD_RE.fullmatch('/id_check_kick'))
        self.assertFalse(ID_CHECK_CMD_RE.fullmatch('/id_check /id_check_kick'))
        self.assertFalse(ID_CHECK_KICK_CMD_RE.fullmatch('/id_check /id_check_kick'))

    def test_narrow_bot_detection_keeps_human_brackets(self):
        values = [{'user_id': 1, 'card': '【摸鱼】小明'}, {'user_id': 2, 'card': '【店员】猫'}, {'user_id': 3, 'card': '系统', 'is_robot': True}]
        result = check_members(values)
        self.assertEqual([v['userId'] for v in result['bad']], ['1'])
        self.assertEqual(len(result['skipped']), 2)


class IdCheckTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(self.temp.name, environ={})
        self.config.values.update(ID_CHECK_OPERATORS='11', ID_CHECK_GROUPS='22')
        self.now, self.calls, self.sends = 1000000, [], []
        self.members = {10: {'user_id': 10, 'card': '机器人', 'role': 'admin'},
                        11: {'user_id': 11, 'card': '604操作员', 'role': 'member'},
                        12: {'user_id': 12, 'card': '不合格甲', 'role': 'member'},
                        13: {'user_id': 13, 'card': '不合格乙', 'role': 'member'}}
        outer = self
        class Protocol:
            self_id = '10'
            timeline = Timeline()
            account_version = 0
            async def api(self, action, params):
                outer.calls.append((action, params))
                if action == 'get_group_member_list':
                    return [dict(v) for v in outer.members.values()]
                if action == 'set_group_kick':
                    return None
                raise AssertionError(action)
            async def member(self, group, user):
                return dict(outer.members[int(user)])
            async def send(self, key, message):
                outer.sends.append((key, message))
                return {'message_id': len(outer.sends)}
        self.protocol = Protocol(); self.protocol.timeline.begin()
        async def pause(delay):
            pass
        self.pause = pause
        self.service = IdCheck(self.config, self.protocol, now=lambda: self.now, pause=pause)
        self.event = {'group_id': 22, 'user_id': 11, 'message_id': 1}

    async def asyncTearDown(self):
        self.temp.cleanup()

    def kicks(self):
        return [params['user_id'] for action, params in self.calls if action == 'set_group_kick']

    async def test_dry_inspection_does_not_arm_and_check_consumed_once(self):
        inspected = await self.service.inspect(22)
        self.assertEqual(len(inspected['bad']), 2)
        self.assertFalse((await self.service.kick_status(22, 11))['can'])
        self.assertTrue((await self.service.run_check(self.event))['ok'])
        self.assertEqual(len(self.sends), 1)
        self.assertTrue((await self.service.kick_status(22, 11))['can'])
        result = await self.service.run_kick(self.event)
        self.assertEqual(result['confirmed'], ['12', '13'])
        self.assertTrue(all(not params['reject_add_request'] for action, params in self.calls if action == 'set_group_kick'))
        await self.service.run_kick(self.event)
        self.assertEqual(self.kicks(), [12, 13])
        await self.service.run_check(self.event)
        self.assertEqual(len(self.sends), 1)

    async def test_scopes_operators_and_console_admin_do_not_bypass_kick(self):
        self.config.values['ADMIN_USERS'] = '99'
        other = {**self.event, 'user_id': 99}
        self.assertTrue((await self.service.run_check(other))['ok'])
        self.assertFalse((await self.service.kick_status(22, 99))['can'])
        self.config.values['ID_CHECK_OPERATORS'] = ''
        await self.service.run_kick(self.event)
        self.assertFalse(self.kicks())
        self.config.values['ID_CHECK_OPERATORS'] = '11'
        await self.service.run_kick({**self.event, 'group_id': 23})
        self.assertFalse(self.kicks())

    async def test_renamed_promoted_and_new_member_are_not_removed(self):
        await self.service.run_check(self.event)
        self.members[12]['card'] = '604 已改名'
        self.members[13]['role'] = 'admin'
        self.members[14] = {'user_id': 14, 'card': '新成员', 'role': 'member'}
        result = await self.service.run_kick(self.event)
        self.assertEqual(result['skipped'], ['12', '13'])
        self.assertFalse(self.kicks())

    async def test_each_member_rechecks_operator_and_bot_roles(self):
        await self.service.run_check(self.event)
        async def pause(delay):
            self.members[10]['role'] = 'member'
        self.service.pause = pause
        result = await self.service.run_kick(self.event)
        self.assertEqual(result['confirmed'], ['12'])
        self.assertEqual(result['remaining'], ['13'])
        self.assertEqual(self.kicks(), [12])

    async def test_unknown_delivery_is_consumed_and_never_replayed(self):
        await self.service.run_check(self.event)
        original = self.protocol.api
        async def api(action, params):
            if action == 'set_group_kick':
                self.calls.append((action, params))
                raise OneBotError('fixture timeout', outcome_unknown=True)
            return await original(action, params)
        self.protocol.api = api
        result = await self.service.run_kick(self.event)
        self.assertEqual(result['uncertain'], ['12'])
        self.assertEqual(result['remaining'], ['13'])
        await self.service.run_kick(self.event)
        restarted = IdCheck(self.config, self.protocol, now=lambda: self.now, pause=self.pause)
        await restarted.run_kick(self.event)
        self.assertEqual(self.kicks(), [12])

    async def test_expiry_reconnect_and_quiet_reject_without_mutation(self):
        await self.service.run_check(self.event)
        self.now += 300001
        await self.service.run_kick(self.event)
        self.assertFalse(self.kicks())
        self.now -= 300001
        self.protocol.timeline.begin()
        await self.service.run_kick(self.event)
        self.assertFalse(self.kicks())
        self.event['message_id'] = 2
        await self.service.run_check(self.event)
        self.service.can_send = lambda key: False
        await self.service.run_kick(self.event)
        self.assertFalse(self.kicks())

    async def test_concurrent_kicks_only_submit_each_target_once(self):
        await self.service.run_check(self.event)
        await asyncio.gather(self.service.run_kick(self.event), self.service.run_kick(self.event))
        self.assertEqual(self.kicks(), [12, 13])

    async def test_fresh_roster_and_uncertain_reminder_not_retried(self):
        async def send(key, message):
            self.sends.append((key, message))
            return {}
        self.protocol.send = send
        result = await self.service.run_check(self.event)
        self.assertFalse(result['ok'])
        self.assertEqual(result['confirmed'], 0)
        await self.service.run_check(self.event)
        self.assertEqual(len(self.sends), 1)
        request = next(iter(self.service.state['checks'].values()))
        self.assertEqual(request['status'], 'uncertain')

    async def test_corrupt_state_fails_closed(self):
        write_json(self.service.file, {'version': 1, 'records': [], 'checks': {}})
        with self.assertRaises(ValueError):
            IdCheck(self.config, self.protocol)

    async def test_cancellation_during_mutation_is_durably_uncertain(self):
        await self.service.run_check(self.event)
        started = asyncio.Event()
        original = self.protocol.api
        async def api(action, params):
            if action == 'set_group_kick':
                self.calls.append((action, params)); started.set()
                await asyncio.Event().wait()
            return await original(action, params)
        self.protocol.api = api
        task = asyncio.create_task(self.service.run_kick(self.event))
        await started.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        record = self.service.state['records']['22']
        self.assertTrue(record['kicked'])
        self.assertEqual(record['steps']['12'], 'uncertain')
        self.assertEqual(record['status'], 'uncertain')
        await self.service.run_kick(self.event)
        self.assertEqual(self.kicks(), [12])

    async def test_zero_message_receipt_is_not_confirmed(self):
        async def send(key, message):
            return {'message_id': 0}
        self.protocol.send = send
        result = await self.service.run_check(self.event)
        self.assertFalse(result['ok'])
        self.assertEqual(result['confirmed'], 0)


if __name__ == '__main__':
    unittest.main()
