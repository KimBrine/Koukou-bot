import asyncio
import tempfile
import unittest
from pathlib import Path

from koukou.config import Config
from koukou.runtime import ModelPool, Runtime, DynamicSearch
from koukou.models import ModelError
from koukou.onebot import OneBot
from koukou.state import read_json, write_json


class Client:
    def __init__(self, session, **spec):
        self.session = session
        self.__dict__.update(spec)

    async def chat(self, *args, **kwargs):
        return self.model

    async def describe(self, *args, **kwargs):
        return self.model


class ModelConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(self.temp.name, environ={})

    def tearDown(self):
        self.temp.cleanup()

    def test_separate_roles_and_unlimited_summary(self):
        self.config.values.update(DEEPSEEK_API_KEY='fixture', DEEPSEEK_MODEL='deepseek-v4-flash', DASHSCOPE_API_KEY='second-fixture',
                                  DASHSCOPE_MODEL='qwen-vl-fixture', SUMMARY_MODEL='deepseek-v4-flash')
        pool = ModelPool(self.config, object(), Client)
        chat, summary, memory = pool.get('chat'), pool.get('summary'), pool.get('memory')
        self.assertIsNot(chat, summary)
        self.assertIsNot(summary, memory)
        self.assertIsNone(summary.max_tokens)
        self.assertGreaterEqual(summary.timeout, 900)
        self.assertEqual(memory.concurrency, 1)
        self.assertEqual(pool.get('sticker-filter').model, 'deepseek-flash')
        self.assertIsNone(pool.get('sticker-filter').max_tokens)
        self.assertEqual(pool.get('sticker-tag').model, 'qwen-vl-fixture')
        self.assertEqual(pool.get('summary-vision').model, 'qwen-vl-fixture')
        self.assertTrue(pool.role('summary').chat.keywords['stream'])
        self.assertTrue(pool.role('summary-vision').describe.keywords['stream'])

    def test_hot_reload_pins_old_client_and_never_reuses_wrong_queue(self):
        self.config.values.update(DEEPSEEK_API_KEY='fixture', DEEPSEEK_MODEL='first')
        pool = ModelPool(self.config, object(), Client)
        proxy = pool.role('chat')
        first, bound = proxy.snapshot(), proxy.chat
        self.assertIs(first, proxy.snapshot())
        self.config.values['DEEPSEEK_MODEL'] = 'second'
        self.assertEqual(proxy.snapshot().model, 'second')
        self.assertIs(bound.func.__self__, first)
        self.assertEqual(first.model, 'first')
        self.assertEqual(bound.keywords['temperature'], 1.2)
        self.config.values['TEMPERATURE'] = '.4'
        self.assertEqual(proxy.chat.keywords['temperature'], .4)

    def test_missing_keys_and_selected_custom_provider(self):
        pool = ModelPool(self.config, object(), Client)
        self.assertFalse(pool.role('chat'))
        with self.assertRaises(ModelError):
            pool.role('chat').chat
        write_json(self.config.data_dir / 'vision-providers.json', [
            {'id': 'first', 'apiKey': 'a', 'baseUrl': 'https://first.example/v1', 'model': 'one'},
            {'id': 'second', 'apiKey': 'b', 'baseUrl': 'https://second.example/v1', 'model': 'two'}])
        self.config.values['VISION_PROVIDER'] = 'custom:second'
        self.assertEqual(pool.get('vision').model, 'two')
        self.config.values['VISION_PROVIDER'] = 'custom:missing'
        self.assertIsNone(pool.get('vision'))

    def test_invalid_endpoint_and_corrupt_provider_fail_before_transport(self):
        self.config.values.update(DEEPSEEK_API_KEY='fixture', DEEPSEEK_BASE_URL='https://user:secret@example.test/v1')
        pool = ModelPool(self.config, object(), Client)
        with self.assertRaises(ValueError):
            pool.get('chat')
        self.config.values['VISION_PROVIDER'] = 'custom'
        write_json(self.config.data_dir / 'vision-providers.json', {'bad': 'state'})
        with self.assertRaises(ValueError):
            pool.get('vision')

    def test_search_toggle_and_provider_snapshot_keeps_cache(self):
        search = DynamicSearch(self.config)
        self.assertTrue(search)
        original = search.snapshot()
        self.assertIs(search.snapshot(), original)
        self.config.values['WEB_SEARCH_ENABLED'] = '0'
        self.assertFalse(search)
        self.config.values.update(WEB_SEARCH_ENABLED='1', WEB_SEARCH_PROVIDER='bing')
        self.assertEqual(search.snapshot().provider_name, 'bing')


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(self.temp.name, environ={})
        self.instances = []

    async def asyncTearDown(self):
        for runtime in self.instances:
            await runtime.close()
        self.temp.cleanup()

    async def create(self, **kwargs):
        runtime = await Runtime.create(self.config, **kwargs)
        self.instances.append(runtime)
        return runtime

    async def test_construction_is_offline_and_stores_are_shared(self):
        runtime = await self.create(session=object(), client_factory=Client)
        self.assertFalse(runtime.onebot.online)
        self.assertIsNone(runtime.onebot.ws)
        self.assertFalse(runtime.tasks)
        self.assertIs(runtime.bot.settings, runtime.admin.settings)
        self.assertIs(runtime.bot.sessions, runtime.admin.sessions)
        self.assertIs(runtime.bot.custom, runtime.admin.custom)
        self.assertIs(runtime.bot.commands, runtime.admin.commands)
        self.assertIs(runtime.bot.actions.registry, runtime.admin.commands)
        self.assertIs(runtime.bot.stickers, runtime.admin.stickers)
        self.assertIs(runtime.bot.media, runtime.admin.media)
        self.assertIs(runtime.bot.summaries, runtime.admin.summaries)
        self.assertIs(runtime.summaries.image_cache, runtime.image_cache)
        self.assertIs(runtime.bot.daily_ping, runtime.admin.daily_ping)
        self.assertIs(runtime.bot.daily_ping, runtime.daily_ping)
        self.assertIs(runtime.bot.id_check, runtime.id_check)
        self.assertIs(runtime.admin.watch, runtime.bot.watch)
        self.assertIs(runtime.bot.metrics, runtime.admin.metrics)
        self.assertIs(runtime.bot.runtime_stats, runtime.admin.runtime_stats)
        self.assertIs(runtime.bot.reply_log, runtime.admin.reply_log)
        self.assertIs(runtime.scheduled.commands, runtime.bot.custom)
        self.assertTrue(runtime.lock.path.exists())
        await runtime.start()
        self.assertFalse(runtime.tasks)
        await runtime.close()
        self.assertFalse(runtime.lock.path.exists())

    async def test_preview_has_no_models_or_protocol_and_cannot_start_workers(self):
        self.config.values.update(DEEPSEEK_API_KEY='fixture', DASHSCOPE_API_KEY='fixture')
        runtime = await self.create(preview=True)
        self.assertIsNone(runtime.session)
        self.assertIsNone(runtime.onebot)
        self.assertIsNone(runtime.bot)
        self.assertIsNone(runtime.admin.model)
        self.assertIsNone(runtime.admin.sticker_tag_model)
        self.assertIsNone(runtime.long_memory.model)
        with self.assertRaises(RuntimeError):
            await runtime.start(connect=True)
        with self.assertRaises(RuntimeError):
            await runtime.start(maintenance=True)
        self.assertFalse(runtime.started)

    async def test_existing_lock_is_preserved_and_failed_load_releases_own_lock(self):
        first = await self.create(preview=True)
        before = read_json(first.lock.path)
        with self.assertRaises(RuntimeError):
            await Runtime.create(self.config, preview=True)
        self.assertEqual(read_json(first.lock.path), before)
        await first.close()
        write_json(self.config.data_dir / 'memory.json', {'invalid': 'data'})
        with self.assertRaises(ValueError):
            await Runtime.create(self.config, preview=True)
        self.assertFalse(first.lock.path.exists())

    async def test_configuration_refresh_rearms_only_changed_schedule(self):
        runtime = await self.create(session=object(), client_factory=Client)
        calls = []
        async def stop():
            calls.append('stop')
        runtime.summaries.schedule.close = stop
        runtime.summaries.start = lambda: calls.append('start')
        await runtime.configure_schedules()
        await runtime.configure_schedules()
        self.assertEqual(calls, ['stop', 'start'])
        self.config.values.update(SUMMARY_TIMES='22:00', HISTORY_LIMIT='32', RATE_LIMIT_PER_HOUR='10', RATE_LIMIT_MIN_GAP_MS='100')
        await runtime.configure_schedules()
        self.assertEqual(calls, ['stop', 'start', 'stop', 'start'])
        self.assertEqual(runtime.memory.limit, 32)
        self.assertEqual(runtime.rate_limiter.per_hour, 10)
        self.assertEqual(runtime.rate_limiter.min_gap_ms, 100)

    async def test_periodic_failure_does_not_stop_later_ticks_and_close_cancels(self):
        runtime = await self.create(preview=True)
        calls, completed = [], asyncio.Event()
        async def tick():
            calls.append(1)
            if len(calls) == 1:
                raise ValueError('fixture')
            completed.set()
        runtime.periodic('fixture', tick, lambda: .01, immediate=True)
        await asyncio.wait_for(completed.wait(), 1)
        await runtime.close()
        size = len(calls)
        await asyncio.sleep(.02)
        self.assertEqual(len(calls), size)
        self.assertFalse(runtime.tasks)

    async def test_manual_memory_cancel_does_not_cancel_other_conversations(self):
        runtime = await self.create(preview=True)
        runtime.preview = False  # Exercise only the isolated maintenance function.
        started, release = asyncio.Event(), asyncio.Event()
        class Slow:
            async def chat(self, *args, **kwargs):
                started.set(); await release.wait(); return '事实笔记'
        runtime.long_memory.model = Slow()
        runtime.long_memory.enqueue('g1', [{'content': '第一段'}])
        runtime.long_memory.enqueue('g2', [{'content': '第二段'}])
        work = asyncio.create_task(runtime.maintain_memory())
        await started.wait()
        runtime.long_memory.edit('g1', '手工笔记', paused=True)
        release.set()
        await asyncio.wait_for(work, 1)
        self.assertEqual(runtime.long_memory.record('g1')['summary'], '手工笔记')
        self.assertEqual(runtime.long_memory.record('g2')['summary'], '事实笔记')

    async def test_loopback_protocol_start_and_shutdown(self):
        from aiohttp import web
        from aiohttp.test_utils import TestServer
        received = []
        async def websocket(request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            async for frame in ws:
                data = frame.json(); received.append(data['action'])
                values = {'get_status': {'online': True}, 'get_login_info': {'user_id': 999}, 'get_group_list': []}
                await ws.send_json({'echo': data['echo'], 'status': 'ok', 'retcode': 0, 'data': values[data['action']]})
            return ws
        app = web.Application(); app.router.add_get('/ws', websocket)
        async with TestServer(app) as server:
            self.config.values['ONEBOT_WS_URL'] = str(server.make_url('/ws')).replace('http:', 'ws:')
            runtime = await self.create(client_factory=Client)
            await runtime.start(connect=True)
            async def online():
                while not runtime.onebot.online:
                    await asyncio.sleep(.01)
            await asyncio.wait_for(online(), 2)
            self.assertEqual(received, ['get_status', 'get_login_info', 'get_group_list'])
            await runtime.close()
            self.assertFalse(runtime.tasks)
            self.assertFalse(runtime.onebot.online)
            self.assertTrue(runtime.session.closed)

    async def test_background_jobs_and_watch_share_lifecycle(self):
        self.config.values.update(SUMMARY_ENABLED='0', TARGET_WATCH_ENABLED='1', TARGET_WATCH_GROUP='22', TARGET_WATCH_USER='11')
        runtime = await self.create(session=object(), client_factory=Client)
        await runtime.start(maintenance=True)
        self.assertIsNotNone(runtime.daily_ping.task)
        self.assertIsNotNone(runtime.scheduled.task)
        self.assertIsNotNone(runtime.bot.watch.task)
        self.assertIn('long-memory', runtime.workers)
        self.assertIn('quiet-greetings', runtime.workers)
        self.config.values['TARGET_WATCH_ENABLED'] = '0'
        await runtime.configure_schedules()
        self.assertIsNone(runtime.bot.watch.task)
        await runtime.close()
        self.assertIsNone(runtime.daily_ping.task)
        self.assertIsNone(runtime.scheduled.task)
        self.assertFalse(runtime.tasks)


if __name__ == '__main__':
    unittest.main()
