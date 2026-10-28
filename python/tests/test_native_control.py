import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock
from types import SimpleNamespace

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

from koukou.config import Config
from koukou.console_server import bind_native_control
from koukou.lifecycle import Lifecycle
from koukou.native_control import _identity, _windows_exited, host_identity, stop_native
from koukou.runtime import Runtime
from koukou.state import InstanceLock, read_json


def fixture(root, **values):
    settings = {'SUMMARY_ENABLED':'0','QUIET_GREETINGS_ENABLED':'0','DAILY_PING_ENABLED':'0',
        'LONG_MEMORY_ENABLED':'0','STICKER_LEARN_ENABLED':'0','TARGET_WATCH_ENABLED':'0',
        'BOT_PROFILE':'offline-control','ONEBOT_WS_URL':'ws://127.0.0.1:1/fixture', **values}
    env = root/'fixture.env'
    env.write_text(''.join(f'{key}={value}\n' for key,value in settings.items()),encoding='utf-8')
    environment={'BOT_DATA_DIR':str(root/'data'),'BOT_LOG_DIR':str(root/'logs'),'BOT_PROFILE':'offline-control'}
    return Config(root,env,environ=environment),settings


class NativeControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_plan_and_mismatches_never_post_or_change_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config,_=fixture(root)
            with InstanceLock(config.data_dir) as lock:
                original=read_json(lock.path);posts=[];remote=_identity(config,original)
                async def identity(request):return web.json_response(remote)
                async def post(request):posts.append(await request.json());return web.json_response({})
                app=web.Application();app.router.add_get('/api/native-instance',identity);app.router.add_post('/api/action/shutdown-native',post)
                async with TestServer(app) as server:
                    before={p.relative_to(root):(p.read_bytes(),p.stat().st_mtime_ns) for p in root.rglob('*') if p.is_file()}
                    plan=await stop_native(config,port=server.port)
                    self.assertTrue(plan['readOnly']);self.assertFalse(plan['requested']);self.assertNotIn(lock.token,json.dumps(plan))
                    self.assertEqual(before,{p.relative_to(root):(p.read_bytes(),p.stat().st_mtime_ns) for p in root.rglob('*') if p.is_file()})
                    config.values['BOT_PROFILE']='wrong-profile'
                    with self.assertRaisesRegex(ValueError,'不匹配'):await stop_native(config,port=server.port,execute=True)
                    config.values['BOT_PROFILE']='offline-control'
                    changed={**original,'runtime':'node'};lock.path.write_text(json.dumps(changed),encoding='utf-8')
                    with self.assertRaisesRegex(ValueError,'Python实例锁'):await stop_native(config,port=server.port,execute=True)
                    lock.path.write_text(json.dumps(original),encoding='utf-8')
                    self.assertFalse(posts)
                    # The initial plan did not mutate any instance file.
                    self.assertEqual(before[next(p for p in before if p.name=='fixture.env')],(config.env_file.read_bytes(),config.env_file.stat().st_mtime_ns))

    async def test_changed_lock_generation_and_old_pid_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config,_=fixture(root)
            with InstanceLock(config.data_dir) as lock:
                original=read_json(lock.path);posts=[];remote=_identity(config,original)
                async def identity(request):return web.json_response(remote)
                async def post(request):posts.append(1);return web.json_response({})
                app=web.Application();app.router.add_get('/api/native-instance',identity);app.router.add_post('/api/action/shutdown-native',post)
                async with TestServer(app) as server:
                    for changed in ({**original,'token':'a'*32},{**original,'pid':original['pid']+1}):
                        lock.path.write_text(json.dumps(changed),encoding='utf-8')
                        with self.assertRaisesRegex(ValueError,'不匹配'):await stop_native(config,port=server.port,execute=True)
                    lock.path.write_text(json.dumps(original),encoding='utf-8')
                    self.assertFalse(posts)

    async def test_preview_cannot_be_closed_and_authentication_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config,_=fixture(root)
            runtime=await Runtime.create(config,preview=True)
            try:
                async with TestServer(runtime.admin.app()) as server,ClientSession() as client:
                    async with client.get(server.make_url('/api/native-instance')) as response:self.assertEqual(response.status,503)
                    async with client.post(server.make_url('/api/action/shutdown-native'),json={'identity':'a'*64}) as response:self.assertEqual(response.status,401)
                    async with client.post(server.make_url('/api/action/shutdown-native'),json={'identity':'a'*64},headers={'X-Admin-Token':runtime.admin.token}) as response:self.assertEqual(response.status,503)
                    self.assertTrue(runtime.lock.owned)
            finally:await runtime.close()

    async def test_timeout_does_not_kill_or_repeat_shutdown(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config,_=fixture(root)
            with InstanceLock(config.data_dir) as lock:
                original=read_json(lock.path);posts=[]
                async def identity(request):return web.json_response(_identity(config,original))
                async def page(request):return web.Response(text='<script>window.__ADMIN_TOKEN__="fixture-token"</script>')
                async def stop(request):posts.append(await request.json());return web.json_response({'ok':True,'accepted':True})
                app=web.Application();app.router.add_get('/api/native-instance',identity);app.router.add_get('/',page);app.router.add_post('/api/action/shutdown-native',stop)
                async with TestServer(app) as server:
                    with self.assertRaisesRegex(RuntimeError,'超时'):await stop_native(config,port=server.port,execute=True,timeout=1)
                self.assertEqual(len(posts),1);self.assertEqual(read_json(lock.path),original)

    async def test_disabled_console_and_replaced_host_lock_refuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config,_=fixture(root,ADMIN_ENABLED='0')
            with self.assertRaisesRegex(ValueError,'ADMIN_ENABLED'):await stop_native(config,execute=True)
            with InstanceLock(config.data_dir) as lock:
                self.assertEqual(host_identity(config,lock)['pid'],os.getpid())
                value=read_json(lock.path);value['token']='b'*32;lock.path.write_text(json.dumps(value),encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError,'归属'):host_identity(config,lock)

    async def test_delayed_shutdown_never_stops_replaced_or_restarted_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config,_=fixture(root)
            stop=asyncio.Event()
            with InstanceLock(config.data_dir) as first:
                old=SimpleNamespace(lock=first,closed=False,admin=SimpleNamespace(lifecycle=Lifecycle(config)))
                bind_native_control(config,old,stop)
                original=read_json(first.path)
                old.admin.lifecycle.stop_native()
                first.path.write_text(json.dumps({**original,'token':'c'*32}),encoding='utf-8')
                await asyncio.sleep(.4)
                self.assertFalse(stop.is_set())
                first.path.write_text(json.dumps(original),encoding='utf-8')
                old.admin.lifecycle.stop_native()
                old.closed=True;first.close()
                with InstanceLock(config.data_dir) as second:
                    current=SimpleNamespace(lock=second,closed=False,admin=SimpleNamespace(lifecycle=Lifecycle(config)))
                    bind_native_control(config,current,stop)
                    await asyncio.sleep(.4)
                    self.assertFalse(stop.is_set())
                    self.assertNotEqual(old.lock.token,current.lock.token)
                    self.assertEqual(current.admin.native_identity()['pid'],os.getpid())

    async def test_malformed_lock_after_ack_is_reported_without_force(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config,_=fixture(root)
            with InstanceLock(config.data_dir) as lock:
                original=read_json(lock.path)
                async def identity(request):return web.json_response(_identity(config,original))
                async def page(request):return web.Response(text='<script>window.__ADMIN_TOKEN__="fixture-token"</script>')
                async def stop(request):
                    lock.path.write_text('[]',encoding='utf-8')
                    return web.json_response({'ok':True,'accepted':True})
                app=web.Application();app.router.add_get('/api/native-instance',identity);app.router.add_get('/',page);app.router.add_post('/api/action/shutdown-native',stop)
                try:
                    async with TestServer(app) as server:
                        with self.assertRaisesRegex(RuntimeError,'锁格式'):await stop_native(config,port=server.port,execute=True)
                    self.assertEqual(lock.path.read_text(encoding='utf-8'),'[]')
                finally:lock.path.write_text(json.dumps(original),encoding='utf-8')


class NativeManagedProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_native_process_authenticates_stops_and_releases_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            async def protocol(request):
                connection=web.WebSocketResponse();await connection.prepare(request)
                values={'get_status':{'online':True},'get_login_info':{'user_id':900001},'get_group_list':[]}
                async for frame in connection:
                    item=frame.json();await connection.send_json({'echo':item['echo'],'status':'ok','retcode':0,'data':values.get(item['action'],{})})
                return connection
            app=web.Application();app.router.add_get('/onebot',protocol)
            with socket.socket() as selected:selected.bind(('127.0.0.1',0));port=selected.getsockname()[1]
            async with TestServer(app) as protocol_server:
                config,settings=fixture(root,ADMIN_PORT=str(port),ONEBOT_WS_URL=str(protocol_server.make_url('/onebot')).replace('http:','ws:'))
                environment={k:v for k,v in os.environ.items() if not k.startswith('BOT_') and k not in settings}
                environment['PYTHONPATH']=str(Path(__file__).resolve().parents[1]);environment['PYTHONASYNCIODEBUG']='1'
                argv=[sys.executable,'-X','utf8','-W','default','-m','koukou','--root',str(root),'--env-file',str(config.env_file),'run','--enable-native','--data-dir',str(config.data_dir),'--log-dir',str(config.log_dir),'--profile','offline-control']
                child=await asyncio.create_subprocess_exec(*argv,cwd=root,env=environment,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
                try:
                    line=(await asyncio.wait_for(child.stdout.readline(),15)).decode('utf-8');self.assertIn(str(port),line)
                    lock=read_json(config.data_dir/'bot.lock');self.assertEqual(lock['runtime'],'python')
                    before=(config.data_dir/'bot.lock').read_bytes()
                    plan=await stop_native(config);self.assertTrue(plan['readOnly']);self.assertEqual((config.data_dir/'bot.lock').read_bytes(),before)
                    stopped=await stop_native(config,execute=True,timeout=15)
                    self.assertTrue(stopped['stopped']);self.assertTrue(stopped['requested']);self.assertFalse(stopped['replacementDetected'])
                    stdout,stderr=await asyncio.wait_for(child.communicate(),15)
                    self.assertEqual(child.returncode,0,stderr.decode('utf-8'));self.assertFalse(stdout)
                    for warning in (b'Unclosed',b'ResourceWarning',b'Task was destroyed'):self.assertNotIn(warning,stderr)
                    self.assertFalse((config.data_dir/'bot.lock').exists())
                    with socket.socket() as free:
                        free.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                        free.bind(('127.0.0.1',port))
                finally:
                    # Only the child created by this isolated fixture is owned here.
                    if child.returncode is None:child.kill();await child.communicate()


class NativePowerShellPlanTests(unittest.TestCase):
    def test_windows_exit_probe_distinguishes_exited_live_and_unknown_handles(self):
        for wait,expected in ((0,True),(258,False),(0xffffffff,False)):
            with self.subTest(wait=wait):
                kernel=MagicMock();kernel.OpenProcess.return_value=123;kernel.WaitForSingleObject.return_value=wait
                self.assertEqual(_windows_exited(900001,kernel),expected)
                kernel.WaitForSingleObject.assert_called_once_with(123,0);kernel.CloseHandle.assert_called_once_with(123)
        for error,expected in ((87,True),(5,False)):
            with self.subTest(error=error):
                kernel=MagicMock();kernel.OpenProcess.return_value=0;kernel.GetLastError.return_value=error
                self.assertEqual(_windows_exited(900001,kernel),expected)
                kernel.WaitForSingleObject.assert_not_called();kernel.CloseHandle.assert_not_called()

    @unittest.skipUnless(os.name=='nt','Windows wrapper')
    def test_windows_wrapper_defaults_to_read_only_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();config,_=fixture(root)
            script=Path(__file__).resolve().parents[2]/'scripts'/'native-python.ps1'
            child=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(script),'-Python',sys.executable,'-Root',str(root),'-EnvFile',str(config.env_file),'-DataDir',str(config.data_dir),'-LogDir',str(config.log_dir),'-Profile','offline-control'],capture_output=True,text=True,encoding='utf-8',timeout=15)
            self.assertEqual(child.returncode,0,child.stderr)
            self.assertTrue(json.loads(child.stdout)['readOnly']);self.assertFalse(config.data_dir.exists());self.assertFalse(config.log_dir.exists())
