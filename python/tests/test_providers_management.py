import asyncio
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from aiohttp import web
from aiohttp.test_utils import TestServer
from koukou.config import Config
from koukou.providers import VisionProviders,detect_models
from koukou.protocol_management import LoginAdapter,LoginManagement
from koukou.lifecycle import Lifecycle
from koukou.onebot import OneBotError
from koukou.state import write_json


class RegistryTests(unittest.TestCase):
    def test_private_keys_masked_empty_edit_preserves_and_bad_state_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=Config(tmp,environ={})
            providers=VisionProviders(config)
            item=providers.add({'name':'本地识图','baseUrl':'http://127.0.0.1:9000/v1','apiKey':'fixture-secret','model':'vision-test'})
            self.assertNotIn('fixture-secret',json.dumps(providers.list()))
            providers.update(item['id'],{'apiKey':'','name':'新名称'})
            self.assertEqual(providers.get(item['id'])['apiKey'],'fixture-secret')
            for url in ['file:///x','https://name:secret@example.test/v1','http://example.test/v1?token=x']:
                with self.assertRaises(ValueError): providers.add({'baseUrl':url,'apiKey':'test'})
            providers.file.write_text('[broken',encoding='utf-8')
            with self.assertRaises(ValueError): VisionProviders(config)
            self.assertEqual(providers.file.read_text(encoding='utf-8'),'[broken')


class ProviderTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_catalog_loopback_supports_both_formats_and_rejects_auth_redirects(self):
        app=web.Application()
        async def models(request):
            self.assertEqual(request.headers['Authorization'],'Bearer unit-key')
            return web.json_response({'models':[{'name':'z'},{'id':'a','owned_by':'test'}]})
        async def redirect(request):return web.Response(status=302,headers={'Location':'http://example.invalid/'})
        app.router.add_get('/v1/models',models);app.router.add_get('/redirect/models',redirect)
        server=TestServer(app);await server.start_server()
        try:
            result=await detect_models(str(server.make_url('/v1')),'unit-key')
            self.assertEqual([v['id'] for v in result['models']],['a','z'])
            with self.assertRaisesRegex(ValueError,'302'):
                await detect_models(str(server.make_url('/redirect')),'unit-key')
        finally:await server.close()

    async def test_napcat_http_hash_login_jwt_and_unauthorized_refresh(self):
        seen=[];logins=[];rejected=[True]
        app=web.Application()
        async def auth(request):
            body=await request.json();logins.append(body['hash'])
            self.assertEqual(body['hash'],hashlib.sha256(b'fixture-token.napcat').hexdigest())
            return web.json_response({'code':0,'data':{'Credential':'jwt-fixture'}})
        async def api(request):
            seen.append((request.path,request.method))
            self.assertEqual(request.headers['Authorization'],'Bearer jwt-fixture')
            if request.match_info['name']=='CheckLoginStatus' and rejected[0]:
                rejected[0]=False
                return web.json_response({'code':-1,'message':'Unauthorized'})
            name=request.match_info['name']
            value={'CheckLoginStatus':{'uin':200000001,'nick':'测试账号','isLogin':True},
                   'GetQuickLoginList':[{'uin':200000001,'nickname':'测试账号','avatar':'face'}],
                   'GetQQLoginQrcode':{'pngBase64QrcodeData':base64.b64encode(b'png').decode(),'expireTime':123}}.get(name,{})
            return web.json_response({'code':0,'data':value})
        app.router.add_post('/api/auth/login',auth)
        app.router.add_route('*','/api/QQLogin/{name}',api)
        server=TestServer(app);await server.start_server()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                config=Config(tmp,environ={'LOGIN_PROVIDER':'napcat','NAPCAT_WEBUI_URL':str(server.make_url('')).rstrip('/'),'NAPCAT_WEBUI_TOKEN':'fixture-token'})
                adapter=LoginAdapter(config)
                self.assertTrue(adapter.status()['available'])
                self.assertNotIn('fixture-token',json.dumps(adapter.status()))
                self.assertEqual((await adapter.info())['uin'],'200000001')
                self.assertEqual(len(logins),2)
                self.assertEqual((await adapter.accounts())[0]['nick'],'测试账号')
                self.assertEqual((await adapter.qrcode())['expireAt'],123)
                self.assertEqual(seen[-1][0],'/api/QQLogin/GetQQLoginQrcode')
        finally:await server.close()

    async def test_llbot_sha256_header_and_local_config_rotation(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'webui_token.txt';file.write_text('fixture-token',encoding='utf-8')
            config=Config(tmp,environ={'LOGIN_PROVIDER':'llbot','LLBOT_WEBUI_TOKEN_FILE':str(file)})
            async def request(url,**kwargs):
                self.assertEqual(kwargs['headers']['X-Webui-Token'],hashlib.sha256(file.read_text().encode()).hexdigest())
                self.assertNotIn('Authorization',kwargs['headers'])
                return 200,{'success':True,'data':{'uin':'200000001','nick':'测试','online':True}}
            adapter=LoginAdapter(config,request=request)
            self.assertTrue((await adapter.info())['online'])
            file.write_text('rotated-token',encoding='utf-8')
            self.assertTrue((await adapter.info())['online'])

    async def test_switch_invalidates_pending_work_and_never_retries_unknown_logout(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=Config(tmp,environ={})
            calls=[]
            class OneBot:
                def invalidate_account(self):calls.append('invalidate')
            class Adapter:
                def status(self):return {'available':True}
                def selected(self):return {}
                async def logout(self,*args):
                    calls.append('logout');raise OneBotError('timeout',outcome_unknown=True)
                async def quick_login(self,*args):calls.append('quick')
            service=LoginManagement(config,OneBot(),adapter=Adapter(),pause=lambda _:asyncio.sleep(0))
            with self.assertRaises(OneBotError):await service.switch('200000001')
            self.assertEqual(calls,['invalidate','logout'])
            with self.assertRaises(ValueError):await service.switch('not an account')

    async def test_quick_login_not_success_until_requested_account_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=Config(tmp,environ={})
            class OneBot:
                def invalidate_account(self):pass
            class Adapter:
                def status(self):return {'available':True}
                def selected(self):return {}
                async def logout(self,*args):return {}
                async def quick_login(self,*args):return {}
                async def info(self,*args):return {'uin':'200000002','nick':'别的号','online':True}
            service=LoginManagement(config,OneBot(),adapter=Adapter(),pause=lambda _:asyncio.sleep(0))
            result=await service.switch('200000001')
            self.assertFalse(result['ok']);self.assertTrue(result['needQr'])

    async def test_offline_quick_login_does_not_require_logout_and_accepts_flagless_llbot(self):
        with tempfile.TemporaryDirectory() as tmp:
            token=Path(tmp)/'token.txt';token.write_text('unit',encoding='utf-8')
            config=Config(tmp,environ={'LOGIN_PROVIDER':'llbot','LLBOT_WEBUI_TOKEN_FILE':str(token)})
            calls=[];logged_in=False
            async def request(url,**kwargs):
                nonlocal logged_in
                name=url.rsplit('/',1)[-1];calls.append(name)
                if name=='quick-login':logged_in=True
                return 200,{'success':True,'data':{'uin':'200000001','nick':'本地夹具'} if logged_in and name=='login-info' else None}
            class OneBot:
                def invalidate_account(self):calls.append('invalidate')
            service=LoginManagement(config,OneBot(),adapter=LoginAdapter(config,request=request),pause=lambda _:asyncio.sleep(0))
            result=await service.switch('200000001')
            self.assertTrue(result['ok']);self.assertNotIn('logout',calls)
            self.assertLess(calls.index('invalidate'),calls.index('quick-login'))

    async def test_qr_image_url_preserves_query_but_rejects_embedded_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=Config(tmp,environ={'LOGIN_PROVIDER':'napcat','NAPCAT_WEBUI_URL':'http://127.0.0.1:6099','NAPCAT_WEBUI_TOKEN':'unit'})
            raw='https://example.invalid/qr.png?ticket=sample&size=200'
            async def request(url,**kwargs):
                if '/api/auth/login' in url:return 200,{'code':0,'data':{'Credential':'jwt-fixture'}}
                return 200,{'code':0,'data':{'url':raw}}
            adapter=LoginAdapter(config,request=request)
            self.assertEqual((await adapter.qrcode())['image'],raw)
            raw='https://name:password@example.invalid/qr.png'
            with self.assertRaises(ValueError):await adapter.qrcode()

    async def test_lifecycle_uses_literal_argv_and_no_process_matching_on_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=Config(tmp,environ={'NAPCAT_DIR':tmp,'NAPCAT_TASK_NAME':'Test protocol'})
            calls=[]
            async def runner(argv,**kwargs):calls.append(argv)
            lifecycle=Lifecycle(config,runner=runner,platform='win32')
            result=await lifecycle.restart_protocol()
            self.assertTrue(result['ok'])
            self.assertIn('-File',calls[0]);self.assertNotIn('-Command',calls[0])
            self.assertEqual(calls[0][-1],'Test protocol')
            config.values['NAPCAT_TASK_NAME']='Other*'
            with self.assertRaises(ValueError):await lifecycle.restart_protocol()
            self.assertEqual(len(calls),1)


if __name__=='__main__':unittest.main()
