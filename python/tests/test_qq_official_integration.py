"""Real local Node bridge + Python runtime; fake Tencent and model endpoints only."""
import asyncio
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from aiohttp import ClientSession, web
from koukou.config import Config
from koukou.official_profile import prepare_profile
from koukou.runtime import Runtime
from koukou.state import read_json
from koukou.__main__ import main

ROOT=Path(__file__).resolve().parents[2]
BRIDGE=ROOT/'integrations'/'qq-official-bridge'
TOKEN='loopback-test-token-with-at-least-32-characters'


class ProfileTests(unittest.TestCase):
    def test_new_profile_is_private_isolated_and_has_no_imported_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'new'
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(['init-qq-official','--destination',str(path)]),0)
            result=json.loads(output.getvalue());c=Config(path,path/'profile.env',environ={})
            self.assertEqual(c.get('QQ_TRANSPORT'),'qq-official')
            self.assertGreaterEqual(len(c.get('KOUKOU_QQ_BRIDGE_TOKEN')),32)
            self.assertNotIn(c.get('KOUKOU_QQ_BRIDGE_TOKEN'),output.getvalue())
            self.assertEqual(list(c.data_dir.iterdir()),[])
            self.assertFalse(result['connected']);self.assertFalse(result['credentialsImported'])
            self.assertFalse(c.get('ADMIN_USERS'));self.assertFalse(c.get('ONEBOT_WS_URL'))
            before=(path/'profile.env').read_bytes()
            with self.assertRaises(ValueError):prepare_profile(path)
            self.assertEqual((path/'profile.env').read_bytes(),before)


@unittest.skipUnless(shutil.which('node') and (BRIDGE/'node_modules'/'ws').is_dir(),'Node bridge dependencies not installed')
class OfficialIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_binding_directed_chat_capabilities_and_restart_keep_one_brain(self):
        class Model:
            calls=[]
            answer='fixture answer [微笑]'
            def __init__(self,*args,**kwargs):self.model=kwargs.get('model','fixture')
            async def chat(self,*args,**kwargs):
                self.calls.append(args)
                await asyncio.sleep(.06)
                return self.answer
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);profile=root/'profile';prepare_profile(profile)
            child=await asyncio.create_subprocess_exec('node',str(BRIDGE/'test'/'python-fixture.mjs'),str(root),
                stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            runtime=None;runner=None
            async def line():
                return json.loads(await asyncio.wait_for(child.stdout.readline(),10))
            async def command(**value):
                child.stdin.write((json.dumps(value)+'\n').encode());await child.stdin.drain()
            async def wait_for(predicate):
                for _ in range(200):
                    if predicate():return
                    await asyncio.sleep(.025)
                self.fail('isolated state transition timed out')
            try:
                ready=await line();self.assertEqual(ready['event'],'ready')
                c=Config(profile,profile/'profile.env',environ={
                    'QQ_OFFICIAL_BRIDGE_URL':f"ws://127.0.0.1:{ready['port']}/bridge",'KOUKOU_QQ_BRIDGE_TOKEN':TOKEN,
                    'DEEPSEEK_API_KEY':'test-only-not-a-real-key','QUIET_HOURS':'','QUIET_HOURS_BLOCK_ALL':'0',
                    'HUMAN_DELAY_MIN_MS':'0','HUMAN_DELAY_MAX_MS':'0','LINE_GAP_MIN_MS':'0','LINE_GAP_MAX_MS':'0',
                    'REPLY_MIN_BUDGET':'0','RATE_LIMIT_MIN_GAP_MS':'0','LONG_MEMORY_ENABLED':'0','STICKERS_ENABLED':'0',
                    'WEB_SEARCH_ENABLED':'0'})
                # Preview initializes a namespace without connecting or making native run unusable.
                preview=await Runtime.create(c,preview=True)
                self.assertIsNone(preview.onebot);await preview.close()
                runtime=await Runtime.create(c,client_factory=Model)
                await runtime.start(connect=True,maintenance=True)
                self.assertNotIn('quiet-greetings',runtime.workers)
                self.assertNotIn('configuration',runtime.workers)
                await wait_for(lambda:runtime.onebot.ws is not None)
                runner=web.AppRunner(runtime.admin.app());await runner.setup()
                site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
                url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
                async with ClientSession() as http:
                    headers={'X-Admin-Token':runtime.admin.token,'Origin':url}
                    response=await http.post(url+'/api/action/qq-official-binding',json={'action':'start'},headers=headers)
                    self.assertEqual(response.status,200)
                    await wait_for(lambda:runtime.onebot.binding_state['phase']=='qr')
                    response=await http.get(url+'/api/qq-official');binding=await response.json()
                    self.assertEqual(binding['binding']['phase'],'qr')
                    self.assertTrue(binding['binding']['qrDataUrl'].startswith('data:image/png;base64,'))
                    self.assertNotIn(TOKEN,json.dumps(binding));self.assertNotIn('appSecret',json.dumps(binding))
                    await command(op='scan');await wait_for(lambda:runtime.onebot.online)
                    await command(op='message',mid='opaque/incoming-1=',text='/Q 1+1')
                    await command(op='message',mid='opaque/noise=',text='unrelated group text',directed=False)
                    try:reply=await line()
                    except TimeoutError:
                        logs=[p.read_text(encoding='utf-8',errors='replace')[-1800:] for p in c.log_dir.rglob('*.log')]
                        self.fail(json.dumps({'calls':len(Model.calls),'online':runtime.onebot.online,
                            'observed':len(runtime.onebot.observed),'seen':list(runtime.bot.seen),'logs':logs}))
                    self.assertEqual(reply['event'],'sent')
                    self.assertIn('fixture answer',reply['text']);self.assertEqual(reply['target']['targetId'],'fixture-group')
                    self.assertEqual(reply['target']['msgId'],'opaque/incoming-1=')
                    self.assertEqual(len(Model.calls),1)
                    await command(op='message',mid='opaque/incoming-2=',text='禁言我十分钟')
                    blocked=await line();self.assertIn('尚未适配',blocked['text']);self.assertEqual(len(Model.calls),1)
                    response=await http.post(url+'/api/action/summary',json={'groupId':1},headers=headers)
                    self.assertEqual(response.status,400);self.assertEqual(len(Model.calls),1)
                    group=next(row for row in runtime.onebot.identity_rows() if row['kind']=='group')
                    response=await http.post(url+'/api/action/update-whitelist',json={'operation':'add','groupIds':[group['alias']]},headers=headers)
                    self.assertEqual(response.status,200)
                    response=await http.post(url+'/api/action/add-private-whitelist',json={'userIds':[12345]},headers=headers)
                    self.assertEqual(response.status,400)
                    state=await (await http.get(url+'/api/state')).json()
                    self.assertEqual(state['backend']['provider'],'qq-official')
                    self.assertFalse(state['backend']['capabilities']['completeHistory'])
                    Model.answer='A'*17000
                    await command(op='message',mid='opaque/long-answer=',text='/Q 完整解释')
                    rejected=await line()
                    self.assertIn('未发送截断内容',rejected['text'])
                    self.assertLess(len(rejected['text']),200)
                await runner.cleanup();runner=None
                await runtime.close();runtime=None
                self.assertFalse((c.data_dir/'bot.lock').exists())
                restarted=await Runtime.create(c,preview=True);await restarted.close()
                marker=read_json(c.data_dir/'qq-official-profile.json')
                self.assertEqual(marker['appId'],'fixture-app')
            finally:
                if runner:await runner.cleanup()
                if runtime:await runtime.close()
                if child.returncode is None:
                    await command(op='stop')
                    try:_,stderr=await asyncio.wait_for(child.communicate(),10)
                    except TimeoutError:
                        child.kill();_,stderr=await child.communicate();raise
                    self.assertEqual(child.returncode,0,stderr.decode())
