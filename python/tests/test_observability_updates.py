"""Native operational services use local fixtures and injected requests only."""
import asyncio
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock
from koukou.config import Config
from koukou.memory import Memory
from koukou.http_client import Response
from koukou.observability import (Metrics, RuntimeStats, ReplyLog, ErrorStore, NativeLogger, Notifier,
    SelfCheck, configured_secrets, day_key, health_alert_for_error, redact, tail_log, today_stats)
from koukou.state import write_json
from koukou.updates import compare_versions, local_version, UpdateChecker


NOW = int(datetime(2026, 1, 2, 16, 1, tzinfo=timezone.utc).timestamp()*1000)


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_china_day_rounding_snapshot_and_persistent_schema(self):
        metrics = Metrics(self.root/'metrics.json', now=lambda:NOW)
        self.assertEqual(day_key(NOW), '2026-01-03')
        metrics.received(); metrics.replied(); metrics.skipped(); metrics.error()
        metrics.sticker(); metrics.search(); metrics.llm(101.5)
        metrics.group('201'); metrics.group(201)
        row = metrics.snapshot(1)[0]
        self.assertEqual(row, {'date':'2026-01-03','received':1,'replied':1,'skipped':1,'errors':1,
                              'stickers':1,'searches':1,'llmMs':102,'llmCount':1,'groups':1})
        self.assertEqual(len(metrics.snapshot(7)), 7)
        self.assertFalse((self.root/'metrics.json').exists())
        metrics.close()
        self.assertEqual(Metrics(self.root/'metrics.json', now=lambda:NOW).snapshot(1), [row])
        copy = metrics.snapshot(1); copy[0]['received'] = 900
        self.assertEqual(metrics.snapshot(1)[0]['received'], 1)

    def test_sixty_day_retention_also_applies_to_group_only_days(self):
        now = [NOW]
        metrics = Metrics(self.root/'metrics.json', now=lambda:now[0])
        for index in range(80):
            now[0] = NOW+index*86400000
            metrics.group(index)
        self.assertEqual(len(metrics.data['days']), 60)
        self.assertNotIn(day_key(NOW), metrics.data['days'])
        self.assertEqual(len(metrics.snapshot(100)), 60)

    def test_corrupt_counters_fail_closed_without_replacing_original(self):
        file = self.root/'metrics.json'
        value = {'days':{'2026-01-01':{'received':-1}}}
        write_json(file, value)
        original = file.read_bytes()
        with self.assertRaises(ValueError):
            Metrics(file)
        self.assertEqual(file.read_bytes(), original)
        metrics = Metrics(self.root/'good.json')
        for field, amount in [('unknown',1), ('received',float('nan')), ('received',-1)]:
            with self.assertRaises(ValueError):
                metrics.bump(field, amount)

    def test_runtime_counts_confirmed_reply_paragraphs_and_china_midnight(self):
        now = [NOW]
        stats = RuntimeStats(now=lambda:now[0])
        stats.note_message('g201', NOW-1000); stats.note_reply('g201'); stats.note_skip()
        self.assertEqual(stats.snapshot()['counters'], {'received':1,'replied':1,'skipped':1})
        self.assertEqual(stats.last_message, {'g201':NOW-1000})
        self.assertEqual(stats.today_replies, 1)
        now[0] += 86400000
        self.assertEqual(stats.today_replies, 0)
        self.assertEqual(stats.total_replied, 1)

    def test_reply_log_tracks_confirmed_targets_without_private_text(self):
        log = ReplyLog(limit=2, now=lambda:NOW)
        log.note({'group_id':201,'user_id':101,'message':'not copied'})
        log.note({'group_id':201,'user_id':102}, NOW+1)
        log.note({'group_id':201,'user_id':101}, NOW+2)
        log.note({'group_id':201,'user_id':103}, NOW+3)
        self.assertEqual(log, {'201:101':NOW+2,'201:103':NOW+3})


class RecordsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.secret = 'example-'+'private-credential'

    def tearDown(self):
        self.temp.cleanup()

    def test_secret_url_query_userinfo_and_json_redaction(self):
        config = Config(self.root, environ={'DEEPSEEK_API_KEY':self.secret,
            'ONEBOT_WS_URL':'ws://localhost:3001?access_token=socket-private-token'})
        values = configured_secrets(config)
        raw = self.secret+' '+self.secret.replace('-', '%2D')+' ws://user:password@localhost:3001/path?access_token=socket-private-token&mode=on#opaque-token'
        safe = redact(raw, values)
        self.assertNotIn(self.secret, safe)
        self.assertNotIn('socket-private-token', safe)
        self.assertNotIn('password@', safe)
        self.assertNotIn('opaque-token', safe)
        self.assertNotIn('test-credential', redact('Authorization: Bearer test-credential'))
        self.assertNotIn('raw-value', redact('{"api_key":"raw-value"}'))
        encoded = self.secret.replace('-', '%2D')
        safe_url = redact('https://download.invalid/file?x='+encoded+'&X-Amz-Signature=signature-private-value', values)
        self.assertNotIn(self.secret, safe_url)
        self.assertNotIn('signature-private-value', safe_url)

    def test_errors_are_bounded_deep_copied_and_old_secrets_hidden(self):
        file = self.root/'errors.json'
        write_json(file, [{'time':NOW,'scope':'bot','level':'warn','message':self.secret}])
        errors = ErrorStore(file, limit=2, now=lambda:NOW, secrets=[self.secret])
        self.assertNotIn(self.secret, errors.list()[0]['message'])
        errors.add('first'); errors.add('second', 'plugin', 'warn')
        self.assertEqual([row['message'] for row in errors.list()], ['second','first'])
        rows = errors.list(); rows[0]['message'] = 'modified'
        self.assertEqual(errors.list()[0]['message'], 'second')
        errors.clear()
        self.assertEqual(json.loads(file.read_text(encoding='utf-8')), [])

    def test_logger_utf8_rotation_and_error_metrics(self):
        stream = io.StringIO()
        errors = ErrorStore(self.root/'errors.json')
        metrics = Metrics(self.root/'metrics.json')
        path = self.root/'bot.log'
        logger = NativeLogger(path, errors=errors, metrics=metrics, secrets=[self.secret], stream=stream, max_bytes=40)
        logger.debug('hidden')
        logger.info('中文不乱码 %s', self.secret)
        logger.warning('第二条警告')
        logger.error('OneBot API 超时：send_group_msg')
        self.assertTrue(Path(str(path)+'.old').exists())
        self.assertEqual(len(errors.list()), 2)
        self.assertEqual(metrics.snapshot(1)[0]['errors'], 1)
        self.assertNotIn(self.secret, stream.getvalue())
        self.assertNotIn('hidden', stream.getvalue())
        self.assertIn('中文不乱码', stream.getvalue())
        self.assertEqual(tail_log(path, 2), [line for line in path.read_text(encoding='utf-8').splitlines()][-2:])

    def test_tail_is_bounded_filtered_and_redacts_legacy_lines(self):
        path = self.root/'legacy.log'
        path.write_text('discard\n'+self.secret+'\nkeep 中文\n', encoding='utf-8')
        values = tail_log(path, 10000, secrets=[self.secret], maximum=100)
        self.assertNotIn(self.secret, '\n'.join(values))
        self.assertEqual(tail_log(path, filter='keep'), ['keep 中文'])
        alert = health_alert_for_error('OneBot API 超时：send_group_msg '+self.secret, secrets=[self.secret])
        self.assertEqual(alert['key'], 'qq-delivery')
        self.assertIn('结果未确认', alert['text'])
        self.assertNotIn(self.secret, alert['text'])
        self.assertEqual(health_alert_for_error('HTTP 429')['key'], 'model-health')
        self.assertIsNone(health_alert_for_error('ordinary text'))

    def test_selfcheck_is_read_only_and_uses_supplied_state(self):
        config = Config(self.root, environ={})
        config.data_dir.mkdir()
        (config.data_dir/'memory.json').write_text('{broken', encoding='utf-8')
        onebot = type('Protocol', (), {'status':lambda s: {'connected':True,'online':False}})()
        before = {str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        report = SelfCheck(config, onebot, now=lambda:NOW).run()
        items = {item['id']:item for item in report['items']}
        self.assertTrue(items['onebot']['ok'])
        self.assertFalse(items['qq']['ok'])
        self.assertFalse(items['deepseek']['ok'])
        self.assertFalse(items['file:memory.json']['ok'])
        after = {str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(report['failed'], sum(not item['ok'] for item in report['items']))

    def test_today_stats_prefers_actual_archive_and_falls_back_to_memory(self):
        memory = Memory(self.root/'memory')
        memory.push('p101', 'user', 'private text', time=NOW)
        memory.push('g201', 'user', 'old text', time=NOW-2*86400000)
        daily = self.root/'daily'
        self.assertEqual(today_stats(daily, memory, now=lambda:NOW)['total'], 1)
        group = daily/'201'; group.mkdir(parents=True)
        (group/(day_key(NOW)+'.jsonl')).write_text('{}\n\n{}\n', encoding='utf-8')
        report = today_stats(daily, memory, now=lambda:NOW)
        self.assertEqual(report, {'date':'2026-01-03','total':2,'perGroup':[{'groupId':'201','count':2}]})


class AsyncServicesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_metrics_deferred_flush_is_cancelled_on_close(self):
        path = self.root/'metrics.json'
        metrics = Metrics(path, flush_seconds=.01)
        metrics.received()
        self.assertIsNotNone(metrics.timer)
        await asyncio.sleep(.03)
        self.assertTrue(path.is_file())
        metrics.replied(); metrics.close()
        self.assertIsNone(metrics.timer)

    async def test_notifier_durable_throttle_unknown_outcome_and_admin_change(self):
        config = Config(self.root, environ={'ADMIN_USERS':'101,102'})
        send = AsyncMock(return_value={})  # Unknown result still reserves throttle.
        onebot = type('Protocol', (), {'send':send})()
        now = [NOW]
        notifier = Notifier(config, onebot, self.root/'notify.json', now=lambda:now[0])
        self.assertFalse(await notifier.notify('offline', 'notice'))
        self.assertFalse(await notifier.notify('offline', 'notice'))
        self.assertEqual(send.await_count, 1)
        rebooted = Notifier(config, onebot, self.root/'notify.json', now=lambda:now[0])
        self.assertFalse(await rebooted.notify('offline', 'notice'))
        send.return_value = {'message_id':1}
        config.values['ADMIN_USERS'] = '103'
        now[0] += 1800000
        self.assertTrue(await rebooted.notify('offline', 'notice'))
        self.assertEqual(send.await_args.args[0], 'p103')

    async def test_notifier_parallel_requests_and_cancelled_unknown_send(self):
        config = Config(self.root, environ={'ADMIN_USERS':'101'})
        entered, release = asyncio.Event(), asyncio.Event()
        async def send(*args):
            entered.set(); await release.wait(); return {'message_id':1}
        onebot = type('Protocol', (), {'send':staticmethod(send)})()
        notifier = Notifier(config, onebot, self.root/'notify.json', now=lambda:NOW)
        task = asyncio.create_task(notifier.notify('issue', 'text'))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertFalse(await notifier.notify('issue', 'text'))

    async def test_updates_semver_actual_local_version_and_strict_tags(self):
        file = self.root/'package.json'
        write_json(file, {'version':'2.31.3'})
        self.assertEqual(local_version(self.root), '2.31.3')
        pairs = [('v2.10.0','2.9.9',1), ('1.0.0','v1.0.0',0), ('0.0.1','0.1.0',-1), ('01.0.0','1.0.0',None), ('2.0.0-beta','2.0.0',None)]
        for a,b,expected in pairs:
            self.assertEqual(compare_versions(a,b), expected)
        fetch = AsyncMock(return_value=Response(200, json.dumps([{'name':'v2.31.3'}, {'name':'v2.32.0'}, {'name':'v9.0.0-dev'}, {'name':'v02.0.0'}]).encode(), {}))
        checker = UpdateChecker(root=self.root, fetch=fetch, now=lambda:NOW)
        value = await checker.check()
        self.assertEqual(value['status'], 'available')
        self.assertEqual(value['latestVersion'], '2.32.0')
        self.assertEqual(value['currentVersion'], '2.31.3')
        self.assertEqual(fetch.await_args.args[0], 'https://api.github.com/repos/KimBrine/Koukou-bot/tags?per_page=100')
        self.assertNotIn('authorization', fetch.await_args.kwargs['headers'])
        value['status'] = 'changed'
        self.assertEqual((await checker.check())['status'], 'available')
        self.assertEqual(fetch.await_count, 1)

    async def test_updates_single_flight_force_backoff_and_failure_privacy(self):
        now = [NOW]
        started, release = asyncio.Event(), asyncio.Event()
        async def fetch(*args, **kwargs):
            started.set(); await release.wait()
            return Response(429, b'', {})
        checker = UpdateChecker('1.0.0', fetch=fetch, now=lambda:now[0])
        first = asyncio.create_task(checker.check())
        await started.wait()
        second = asyncio.create_task(checker.check(force=True))
        first.cancel()
        with self.assertRaises(asyncio.CancelledError): await first
        self.assertFalse(checker.inflight.cancelled())
        release.set()
        result = await second
        self.assertIn('限流', result['message'])
        self.assertIsNone(checker.inflight)
        checker.fetch = AsyncMock(side_effect=OSError('https://secret.invalid?access_token=do-not-leak'))
        self.assertEqual((await checker.check(force=True))['message'], result['message'])
        self.assertEqual(checker.fetch.await_count, 0)
        now[0] += 31000
        failed = await checker.check(force=True)
        self.assertNotIn('do-not-leak', failed['message'])
        self.assertNotIn('secret.invalid', failed['message'])
        self.assertEqual(checker.fetch.await_count, 1)
        self.assertEqual((await checker.check())['status'], 'error')
        self.assertEqual(checker.fetch.await_count, 1)


if __name__ == '__main__':
    unittest.main()
