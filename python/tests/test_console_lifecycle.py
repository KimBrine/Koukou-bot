import asyncio
import json
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from koukou.config import Config
from koukou.console_server import serve_preview
from koukou.runtime import Runtime
from koukou.state import read_json


def fixture_root(root):
    assets = root / 'src' / 'admin'
    assets.mkdir(parents=True)
    (assets / 'ui.html').write_text('<html><body>offline preview</body></html>', encoding='utf-8')
    (root / 'python').mkdir()
    (root / 'python' / 'migration-contract.json').write_text(json.dumps({
        'baseline': 'offline-fixture', 'modules': [], 'get': [], 'actions': []}), encoding='utf-8')


class PreviewProcessTests(unittest.TestCase):
    def run_child_command(self, root, command):
        """One complete preview lifetime in a process, including abnormal exit."""
        child = subprocess.Popen(
            [sys.executable, '-X', 'utf8', '-W', 'default',
             str(Path(__file__).with_name('lifecycle_worker.py')), str(root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8',
            env={**os.environ, 'PYTHONASYNCIODEBUG': '1'})
        lines = queue.Queue()
        reader = threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True)
        reader.start()
        try:
            line = lines.get(timeout=15)
            self.assertTrue(line, 'preview exited before readiness')
            ready = json.loads(line)
            # communicate closes stdin and drains both output pipes before wait.
            stdout, stderr = child.communicate(command+'\n', timeout=15)
            self.assertFalse(stdout)
            reader.join(timeout=5)
            return ready, child.returncode, stderr
        finally:
            if child.poll() is None:
                child.kill(); child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None and not stream.closed:
                    stream.close()

    def test_process_signal_exit_cleans_lock_and_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_root(root)
            ready, status, error = self.run_child_command(root, 'signal')
            self.assertEqual(status, 0, error)
            self.assertFalse((root / 'isolated-data' / 'bot.lock').exists())
            for warning in ('ResourceWarning', 'Task was destroyed', 'Unclosed'):
                self.assertNotIn(warning, error)
            with socket.socket() as free:
                free.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                free.bind(('127.0.0.1', ready['port']))

    def test_process_crash_stale_lock_is_recovered_by_next_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_root(root)
            first, status, error = self.run_child_command(root, 'crash')
            self.assertEqual(status, 73, error)
            lock = root / 'isolated-data' / 'bot.lock'
            self.assertEqual(read_json(lock)['token'], first['lockToken'])
            second, status, error = self.run_child_command(root, 'stop')
            self.assertEqual(status, 0, error)
            self.assertNotEqual(second['lockToken'], first['lockToken'])
            self.assertFalse(lock.exists())

    def test_process_console_restart_stop_releases_port_and_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_root(root)
            child = subprocess.Popen(
                [sys.executable, '-X', 'utf8', '-W', 'default',
                 str(Path(__file__).with_name('lifecycle_worker.py')), str(root)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding='utf-8',
                env={**os.environ, 'PYTHONASYNCIODEBUG': '1'})
            lines = queue.Queue()

            def read_output():
                for line in child.stdout:
                    lines.put(line)
                lines.put(None)

            reader = threading.Thread(target=read_output, daemon=True)
            reader.start()

            def boot():
                line = lines.get(timeout=15)
                self.assertIsNotNone(line, 'preview exited before readiness')
                return json.loads(line)

            def request(port, path, body=None, token=None):
                headers = {'Content-Type': 'application/json'}
                if token is not None:
                    headers['X-Admin-Token'] = token
                value = Request(f'http://127.0.0.1:{port}'+path,
                    data=None if body is None else json.dumps(body).encode(), headers=headers)
                try:
                    with urlopen(value, timeout=5) as response:
                        return response.read().decode('utf-8')
                except HTTPError as error:
                    # Avoid leaking urllib's response file, including failures.
                    error.read(); error.close()
                    raise

            try:
                first = boot()
                port = first['port']
                html = request(port, '/')
                self.assertIn('QQ和模型调用已禁用', html)
                token = re.search(r'window.__ADMIN_TOKEN__="([^"]+)"', html).group(1)
                self.assertTrue(json.loads(request(port, '/api/ping'))['ok'])
                self.assertFalse(json.loads(request(port, '/api/state'))['bot']['online'])
                self.assertTrue(json.loads(request(port, '/api/action/set-config',
                    {'key': 'QUIET_HOURS', 'value': '02:00-08:00'}, token))['ok'])
                lock = root / 'isolated-data' / 'bot.lock'
                # Windows venv launchers may delegate to a second python.exe.
                self.assertEqual(read_json(lock)['pid'], first['pid'])
                self.assertEqual(read_json(lock)['token'], first['lockToken'])
                self.assertEqual(json.loads(request(port, '/api/action/restart-bot', {}, token)), {'ok': True})
                second = boot()
                self.assertEqual(second['generation'], 2)
                self.assertEqual(second['port'], port)
                self.assertNotEqual(second['lockToken'], first['lockToken'])
                self.assertEqual(read_json(lock)['token'], second['lockToken'])
                self.assertEqual(json.loads(request(port, '/api/state'))['config']['quietHours'], '02:00-08:00')
                second_html = request(port, '/')
                second_token = re.search(r'window.__ADMIN_TOKEN__="([^"]+)"', second_html).group(1)
                self.assertNotEqual(second_token, token)
                with self.assertRaises(HTTPError) as rejected:
                    request(port, '/api/action/restart-bot', {}, token)
                self.assertEqual(rejected.exception.code, 401)
                rejected.exception.close()
                child.stdin.write('stop\n'); child.stdin.flush(); child.stdin.close()
                child.wait(timeout=15)
                reader.join(timeout=5)
                error = child.stderr.read()
                self.assertEqual(child.returncode, 0, error)
                for warning in ('ResourceWarning', 'Unclosed client session', 'Task was destroyed', 'unclosed transport'):
                    self.assertNotIn(warning, error)
                self.assertFalse(lock.exists())
                with socket.socket() as free:
                    free.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    free.bind(('127.0.0.1', port))
            finally:
                if child.poll() is None:
                    if not child.stdin.closed:
                        try:
                            child.stdin.write('stop\n'); child.stdin.flush(); child.stdin.close()
                        except (BrokenPipeError, OSError):
                            pass
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill(); child.wait(timeout=5)
                for stream in (child.stdin, child.stdout, child.stderr):
                    if stream is not None and not stream.closed:
                        stream.close()


class PreviewCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        fixture_root(self.root)
        self.config = Config(self.root, environ={})

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_cancelled_host_releases_lock_and_all_waiters(self):
        ready, runtimes = asyncio.Event(), []

        def started(runtime, *_):
            runtimes.append(runtime); ready.set()

        task = asyncio.create_task(serve_preview(self.config, 0, ready=started, handle_signals=False))
        await asyncio.wait_for(ready.wait(), 3)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(runtimes[0].closed)
        self.assertFalse(runtimes[0].lock.path.exists())
        runtime = await Runtime.create(self.config, preview=True)
        await runtime.close()
        self.assertFalse([task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()])

    async def test_occupied_port_startup_failure_releases_own_lock(self):
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0)); occupied.listen()
            with self.assertRaises(OSError):
                await serve_preview(self.config, occupied.getsockname()[1], handle_signals=False)
        self.assertFalse((self.config.data_dir / 'bot.lock').exists())
        runtime = await Runtime.create(self.config, preview=True)
        await runtime.close()

    async def test_already_stopped_host_never_initializes_data(self):
        stop = asyncio.Event(); stop.set()
        await serve_preview(self.config, 0, stop=stop, handle_signals=False)
        self.assertFalse(self.config.data_dir.exists())

    async def test_concurrent_shutdown_waits_for_transport_before_releasing_lock(self):
        runtime = await Runtime.create(self.config, preview=True)
        entered, release = asyncio.Event(), asyncio.Event()

        class SlowTransport:
            async def close(self):
                entered.set()
                await release.wait()

        runtime.onebot = SlowTransport()
        first = asyncio.create_task(runtime.close())
        await asyncio.wait_for(entered.wait(), 3)
        second = asyncio.create_task(runtime.close())
        first.cancel()
        await asyncio.sleep(.01)
        first.cancel()
        await asyncio.sleep(.01)
        self.assertFalse(first.done())
        self.assertFalse(second.done())
        self.assertTrue(runtime.lock.path.exists())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await first
        await second
        self.assertFalse(runtime.lock.path.exists())

    async def test_app_creation_failure_releases_own_lock(self):
        runtimes = []

        async def factory(config, **kwargs):
            runtime = await Runtime.create(config, **kwargs)
            runtimes.append(runtime)
            def broken():
                raise RuntimeError('fixture-app-failure')
            runtime.admin.app = broken
            return runtime

        with self.assertRaisesRegex(RuntimeError, 'fixture-app-failure'):
            await serve_preview(self.config, 0, runtime_factory=factory, handle_signals=False)
        self.assertTrue(runtimes[0].closed)
        self.assertFalse(runtimes[0].lock.path.exists())

    async def test_repeated_host_cancellation_waits_for_http_cleanup(self):
        ready, entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        runtimes = []

        async def factory(config, **kwargs):
            runtime = await Runtime.create(config, **kwargs)
            runtimes.append(runtime)
            original = runtime.admin.app
            def app():
                result = original()
                async def slow_cleanup(_):
                    entered.set()
                    await release.wait()
                result.on_cleanup.append(slow_cleanup)
                return result
            runtime.admin.app = app
            return runtime

        task = asyncio.create_task(serve_preview(self.config, 0, ready=lambda *_: ready.set(),
            runtime_factory=factory, handle_signals=False))
        await asyncio.wait_for(ready.wait(), 3)
        task.cancel()
        await asyncio.wait_for(entered.wait(), 3)
        task.cancel()
        await asyncio.sleep(.01)
        self.assertFalse(task.done())
        self.assertTrue(runtimes[0].lock.path.exists())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(runtimes[0].lock.path.exists())
