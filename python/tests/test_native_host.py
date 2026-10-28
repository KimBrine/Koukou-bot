import asyncio
from pathlib import Path
import tempfile
import unittest

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

from koukou.config import Config
from koukou.console_server import serve_native
from koukou.state import read_json


class NativeHostTests(unittest.IsolatedAsyncioTestCase):
    async def test_loopback_start_restart_stop_closes_protocol_and_background_workers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            connections, requests, runtimes = [], [], []
            booted, stop = asyncio.Queue(), asyncio.Event()

            async def protocol(request):
                socket = web.WebSocketResponse()
                await socket.prepare(request)
                connections.append(socket)
                values = {'get_status':{'online':True}, 'get_login_info':{'user_id':900001}, 'get_group_list':[]}
                async for frame in socket:
                    item = frame.json()
                    requests.append(item['action'])
                    if item['action'] in values:
                        await socket.send_json({'echo':item['echo'], 'status':'ok', 'retcode':0, 'data':values[item['action']]})
                    else:
                        await socket.send_json({'echo':item['echo'], 'status':'failed', 'retcode':100, 'message':'offline fixture rejects mutations'})
                return socket

            app = web.Application()
            app.router.add_get('/onebot', protocol)
            async with TestServer(app) as server:
                config = Config(root, root/'native.env', environ={
                    'BOT_DATA_DIR':str(root/'isolated-data'), 'BOT_LOG_DIR':str(root/'isolated-logs'),
                    'ONEBOT_WS_URL':str(server.make_url('/onebot')).replace('http:', 'ws:'),
                    'SUMMARY_ENABLED':'0', 'QUIET_GREETINGS_ENABLED':'0', 'DAILY_PING_ENABLED':'0',
                    'LONG_MEMORY_ENABLED':'0', 'STICKER_LEARN_ENABLED':'0', 'PROACTIVE_RATE':'0',
                    'TARGET_WATCH_ENABLED':'1', 'TARGET_WATCH_GROUP':'900002', 'TARGET_WATCH_USER':'900003'})

                def ready(runtime, port, generation):
                    runtimes.append(runtime)
                    booted.put_nowait((runtime, port, generation))

                async def online(runtime):
                    while not runtime.onebot.online:
                        await asyncio.sleep(.01)

                host = asyncio.create_task(serve_native(config, 0, stop=stop, ready=ready, handle_signals=False))
                try:
                    first, port, generation = await asyncio.wait_for(booted.get(), 5)
                    await asyncio.wait_for(online(first), 5)
                    self.assertEqual(generation, 1)
                    self.assertTrue(first.started)
                    self.assertFalse(first.preview)
                    self.assertIn('onebot', first.workers)
                    self.assertIn('configuration', first.workers)
                    self.assertIn('quiet-greetings', first.workers)
                    self.assertIsNotNone(first.scheduled.task)
                    self.assertIsNotNone(first.daily_ping.task)
                    self.assertIsNotNone(first.bot.watch.task)
                    first_tasks = list(first.tasks)+[first.scheduled.task, first.daily_ping.task, first.bot.watch.task]
                    first_lock = read_json(first.lock.path)['token']
                    async with ClientSession() as http:
                        response = await http.get(f'http://127.0.0.1:{port}/api/state')
                        self.assertEqual(response.status, 200)
                        self.assertTrue((await response.json())['bot']['online'])
                        response = await http.post(f'http://127.0.0.1:{port}/api/action/restart-bot',
                            json={}, headers={'X-Admin-Token':first.admin.token})
                        self.assertEqual(response.status, 200)
                        self.assertTrue((await response.json())['ok'])
                    second, second_port, generation = await asyncio.wait_for(booted.get(), 5)
                    await asyncio.wait_for(online(second), 5)
                    self.assertEqual((second_port, generation), (port, 2))
                    self.assertTrue(first.closed)
                    self.assertTrue(first.session.closed)
                    self.assertFalse(first.onebot.online)
                    self.assertTrue(all(task.done() for task in first_tasks))
                    self.assertFalse(first.tasks)
                    self.assertIsNone(first.scheduled.task)
                    self.assertIsNone(first.daily_ping.task)
                    self.assertIsNone(first.bot.watch.task)
                    self.assertNotEqual(read_json(second.lock.path)['token'], first_lock)
                    self.assertNotEqual(first.admin.token, second.admin.token)
                    self.assertEqual(len(connections), 2)
                    self.assertTrue(connections[0].closed)
                    self.assertTrue(set(requests) <= {'get_status','get_login_info','get_group_list'})
                    second_tasks = list(second.tasks)+[second.scheduled.task, second.daily_ping.task, second.bot.watch.task]
                    stop.set()
                    await asyncio.wait_for(host, 5)
                    self.assertTrue(second.closed)
                    self.assertTrue(second.session.closed)
                    self.assertTrue(all(task.done() for task in second_tasks))
                    self.assertFalse(second.tasks)
                    self.assertFalse(second.lock.path.exists())
                    self.assertTrue(all(socket.closed for socket in connections))
                    self.assertFalse(second.onebot.tasks)
                finally:
                    stop.set()
                    if not host.done():
                        await asyncio.wait_for(host, 5)
