import asyncio
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

from koukou.__main__ import main
from koukou.native_cli import native_plan, resolve_native_config


def fixture(root, **values):
    settings = {
        'SUMMARY_ENABLED': '0', 'QUIET_GREETINGS_ENABLED': '0', 'DAILY_PING_ENABLED': '0',
        'LONG_MEMORY_ENABLED': '0', 'STICKER_LEARN_ENABLED': '0', 'PROACTIVE_RATE': '0',
        'TARGET_WATCH_ENABLED': '0', 'BOT_PROFILE': 'offline-cli',
        'ONEBOT_WS_URL': 'ws://127.0.0.1:1/fixture',
        **values,
    }
    file = root / 'fixture.env'
    file.write_text(''.join(f'{key}={value}\n' for key, value in settings.items()), encoding='utf-8')
    return file, settings


def command(root, env_file):
    return ['--root', str(root), '--env-file', str(env_file), 'run',
            '--data-dir', str(root/'isolated-data'), '--log-dir', str(root/'isolated-logs')]


def child_environment(settings):
    result = {key: value for key, value in os.environ.items()
              if key not in settings and not key.startswith('BOT_')}
    result['PYTHONPATH'] = str(Path(__file__).resolve().parents[1])
    result['PYTHONASYNCIODEBUG'] = '1'
    return result


class NativeCliPlanTests(unittest.TestCase):
    def test_default_run_stays_gated_without_resolving_configuration(self):
        with patch.dict(os.environ, {}, clear=True), redirect_stderr(io.StringIO()) as error:
            self.assertEqual(main(['run']), 2)
        self.assertIn('拒绝连接QQ', error.getvalue())

    def test_check_plan_is_read_only_and_does_not_print_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            env_file, _ = fixture(root, DEEPSEEK_API_KEY='do-not-print-fixture-secret')
            before = {path.relative_to(root): path.read_bytes() for path in root.rglob('*') if path.is_file()}
            with patch.dict(os.environ, {}, clear=True), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(command(root, env_file)+['--check', '--profile', 'inspection', '--port', '8999']), 0)
            plan = json.loads(output.getvalue())
            self.assertEqual(plan['profile'], 'inspection')
            self.assertEqual(plan['console'], {'enabled': True, 'host': '127.0.0.1', 'port': 8999})
            self.assertEqual(plan['dataDir'], str(root/'isolated-data'))
            self.assertTrue(plan['readOnly'])
            self.assertNotIn('do-not-print-fixture-secret', output.getvalue())
            self.assertEqual(before, {path.relative_to(root): path.read_bytes() for path in root.rglob('*') if path.is_file()})
            self.assertEqual(set(root.iterdir()), {env_file})

    def test_only_start_process_or_cli_may_supply_absolute_instance_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            env_file, _ = fixture(root, BOT_DATA_DIR=str(root/'from-file'), BOT_LOG_DIR=str(root/'logs-from-file'))
            with self.assertRaisesRegex(ValueError, 'BOT_DATA_DIR'):
                resolve_native_config(root, env_file, environ={})
            for data, logs, name in (('relative', root/'logs', 'BOT_DATA_DIR'),
                                     (root/'data', 'relative', 'BOT_LOG_DIR')):
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, name):
                    resolve_native_config(root, env_file, data_dir=data, log_dir=logs, environ={})
            config = resolve_native_config(root, env_file, environ={
                'BOT_DATA_DIR': str(root/'from-process'), 'BOT_LOG_DIR': str(root/'process-logs'),
                'BOT_PROFILE': 'process-profile'}, data_dir=root/'from-cli', profile='cli-profile')
            self.assertEqual(config.data_dir, root/'from-cli')
            self.assertEqual(config.log_dir, root/'process-logs')
            self.assertEqual(config.get('BOT_PROFILE'), 'cli-profile')
            self.assertEqual(config.environ['BOT_PROFILE'], 'cli-profile')
            self.assertEqual(set(root.iterdir()), {env_file})

    def test_missing_config_and_invalid_port_or_profile_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            options = {'data_dir': root/'data', 'log_dir': root/'logs', 'environ': {}}
            with self.assertRaisesRegex(ValueError, '已存在'):
                resolve_native_config(root, root/'missing.env', **options)
            env_file, _ = fixture(root)
            for port in (0, 1023, 65536, True):
                with self.subTest(port=port), self.assertRaises(ValueError):
                    resolve_native_config(root, env_file, port=port, **options)
            with self.assertRaisesRegex(ValueError, 'BOT_PROFILE'):
                resolve_native_config(root, env_file, profile='bad\nprofile', **options)

    def test_plan_honors_console_switch_and_configured_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            env_file, _ = fixture(root, ADMIN_ENABLED='0', ADMIN_PORT='8891')
            config = resolve_native_config(root, env_file, data_dir=root/'data', log_dir=root/'logs', environ={})
            self.assertEqual(native_plan(config)['console'], {'enabled': False, 'host': '127.0.0.1', 'port': 8891})

    def test_subprocess_refuses_live_legacy_lock_before_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            env_file, settings = fixture(root)
            data = root/'isolated-data'
            data.mkdir()
            lock = data/'bot.lock'
            # Node's lock shape, backed by a demonstrably live backend PID.
            value = json.dumps({'pid': os.getpid(), 'profile': 'main', 'startedAt': 1})
            lock.write_text(value, encoding='utf-8')
            child = subprocess.run([sys.executable, '-X', 'utf8', '-m', 'koukou',
                                    *command(root, env_file), '--enable-native'],
                cwd=root, env=child_environment(settings), capture_output=True, text=True,
                encoding='utf-8', timeout=15)
            self.assertEqual(child.returncode, 1, child.stderr)
            self.assertIn('bot.lock', child.stderr)
            self.assertEqual(lock.read_text(encoding='utf-8'), value)
            self.assertFalse((root/'isolated-logs').exists())
            self.assertNotIn('Unclosed', child.stderr)


class NativeCliProcessTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, enabled):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            connections, actions = [], []
            online = asyncio.Event()

            async def protocol(request):
                connection = web.WebSocketResponse()
                await connection.prepare(request)
                connections.append(connection)
                values = {'get_status': {'online': True}, 'get_login_info': {'user_id': 900001}, 'get_group_list': []}
                async for frame in connection:
                    item = frame.json()
                    actions.append(item['action'])
                    await connection.send_json({'echo': item['echo'], 'status': 'ok', 'retcode': 0,
                                                'data': values.get(item['action'], {})})
                    if item['action'] == 'get_group_list':
                        online.set()
                return connection

            app = web.Application()
            app.router.add_get('/onebot', protocol)
            # When disabled this port deliberately stays occupied. Native tasks
            # must start without accidentally binding the console anyway.
            with socket.socket() as reserved:
                reserved.bind(('127.0.0.1', 0))
                port = reserved.getsockname()[1]
                if not enabled:
                    reserved.listen()
                else:
                    reserved.close()
                async with TestServer(app) as server:
                    env_file, settings = fixture(root, ADMIN_ENABLED='1' if enabled else '0', ADMIN_PORT=str(port),
                        ONEBOT_WS_URL=str(server.make_url('/onebot')).replace('http:', 'ws:'))
                    child = await asyncio.create_subprocess_exec(sys.executable, '-X', 'utf8', '-W', 'default',
                        str(Path(__file__).with_name('native_cli_worker.py')), *command(root, env_file), '--enable-native',
                        cwd=root, env=child_environment(settings), stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    try:
                        line = (await asyncio.wait_for(child.stdout.readline(), 15)).decode('utf-8')
                        self.assertIn('Python迁移控制台', line)
                        self.assertIn(str(port) if enabled else '关闭HTTP监听', line)
                        await asyncio.wait_for(online.wait(), 10)
                        lock = root/'isolated-data'/'bot.lock'
                        self.assertTrue(lock.exists())
                        if enabled:
                            async with ClientSession() as http:
                                response = await http.get(f'http://127.0.0.1:{port}/api/ping')
                                self.assertEqual(response.status, 200)
                                self.assertTrue((await response.json())['ok'])
                        self.assertTrue(set(actions) <= {'get_status', 'get_login_info', 'get_group_list'})
                        stdout, stderr = await asyncio.wait_for(child.communicate(b'stop\n'), 15)
                        self.assertEqual(child.returncode, 0, stderr.decode('utf-8'))
                        self.assertFalse(stdout)
                        for warning in (b'ResourceWarning', b'Task was destroyed', b'Unclosed', b'unclosed transport'):
                            self.assertNotIn(warning, stderr)
                        self.assertFalse(lock.exists())
                        for _ in range(50):
                            if all(connection.closed for connection in connections):
                                break
                            await asyncio.sleep(.01)
                        self.assertTrue(all(connection.closed for connection in connections))
                    finally:
                        if child.returncode is None:
                            child.kill()
                            await child.communicate()
                if enabled:
                    with socket.socket() as free:
                        free.bind(('127.0.0.1', port))

    async def test_enabled_native_subprocess_uses_config_port_and_cleans_resources(self):
        await self.exercise(True)

    async def test_disabled_console_still_runs_native_and_cleans_resources(self):
        await self.exercise(False)
