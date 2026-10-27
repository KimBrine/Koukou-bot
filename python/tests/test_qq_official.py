"""Official QQ fixtures use only temporary profiles and loopback WebSockets."""
import asyncio
import base64
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest

from aiohttp import web
from aiohttp.test_utils import TestServer

from koukou.config import Config
from koukou.onebot import OneBotError, confirmed_message_id
from koukou.qq_official import OfficialQQ, PROTOCOL, CAPABILITIES
from koukou.qq_official_identity import IdentityRegistry, validate_official_profile
from koukou.state import read_json, write_json


TOKEN = 'test-only-local-bridge-token-1234567890'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')


def config(root, **values):
    return Config(root, Path(root)/'official.env', environ={
        'BOT_DATA_DIR':str(Path(root)/'data'), 'BOT_LOG_DIR':str(Path(root)/'logs'),
        'KOUKOU_QQ_BRIDGE_TOKEN':TOKEN, 'QQ_OFFICIAL_BRIDGE_URL':'ws://127.0.0.1:18792/bridge', **values})


def status(app='fixture-app', online=True):
    return {'protocol':PROTOCOL, 'appId':app, 'online':online,
            'capabilities':dict(CAPABILITIES), 'binding':{'phase':'bound' if app else 'unbound'}, 'sdkVersion':'1.0.5'}


def message(kind='group', sender='opaque-user', target='opaque-group', mid='sdk-msg-1', **values):
    return {'type':'qq-message','appId':'fixture-app','data':{
        'kind':kind,'senderId':sender,'groupOpenid':target,'messageId':mid,'timestamp':time.time(),
        'content':'fixture question','rawEventType':'GROUP_AT_MESSAGE_CREATE' if kind=='group' else 'C2C_MESSAGE_CREATE', **values}}


class Owner:
    closed = False
    def __init__(self):self.sent=[]
    async def close(self):self.closed=True


class OfficialIdentityTests(unittest.TestCase):
    def test_profile_validation_is_read_only_and_rejects_legacy_data_and_settings(self):
        with tempfile.TemporaryDirectory() as root:
            c=config(root)
            self.assertTrue(validate_official_profile(c)['isolated'])
            self.assertFalse(c.data_dir.exists())
            for key in ['ONEBOT_WS_URL','ONEBOT_ACCESS_TOKEN','WHITELIST_GROUPS','PRIVATE_WHITELIST','ADMIN_USERS']:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    validate_official_profile(config(root,**{key:'12345'}))
            c.data_dir.mkdir();file=c.data_dir/'memory.json';file.write_text('{}',encoding='utf-8')
            before=file.read_bytes()
            with self.assertRaises(ValueError):OfficialQQ(c)
            self.assertEqual(file.read_bytes(),before)
            self.assertFalse((c.data_dir/'qq-official-profile.json').exists())

    def test_typed_application_identity_roundtrip_and_lists_do_not_inherit_qq_roles(self):
        with tempfile.TemporaryDirectory() as root:
            c=config(root);r=IdentityRegistry(c);r.bind('fixture-app')
            group=r.allocate('group','same-opaque')
            private=r.allocate('c2c','same-opaque')
            member=r.allocate('group-user','same-opaque',parent='same-opaque')
            other_member=r.allocate('group-user','same-opaque',parent='other-group')
            self.assertEqual(len({group,private,member,other_member}),4)
            self.assertTrue(all(len(h)==15 and int(h)<2**53 for h in [group,private,member]))
            self.assertEqual(IdentityRegistry(c).allocate('group','same-opaque'),group)
            self.assertEqual(validate_official_profile(config(root,WHITELIST_GROUPS=group,PRIVATE_WHITELIST=private,ADMIN_USERS=member))['appId'],'fixture-app')
            with self.assertRaises(ValueError):validate_official_profile(config(root,PRIVATE_WHITELIST=member))
            with self.assertRaises(ValueError):validate_official_profile(config(root,WHITELIST_GROUPS=private))
            before=(c.data_dir/'qq-official-profile.json').read_bytes()
            with self.assertRaises(ValueError):r.bind('different-app')
            self.assertEqual((c.data_dir/'qq-official-profile.json').read_bytes(),before)

    def test_remote_urls_weak_tokens_and_linked_registry_are_rejected_before_connect(self):
        with tempfile.TemporaryDirectory() as root:
            for url in ['ws://example.invalid:18792/bridge','http://127.0.0.1:18792/bridge',
                        'ws://localhost:18792/bridge','ws://user:pass@127.0.0.1:18792/bridge',
                        'ws://127.0.0.1:18792/bridge?token=secret','ws://127.0.0.1/bridge']:
                with self.subTest(url=url),self.assertRaises(ValueError):OfficialQQ(config(root,QQ_OFFICIAL_BRIDGE_URL=url))
            with self.assertRaises(ValueError):OfficialQQ(config(root,KOUKOU_QQ_BRIDGE_TOKEN='short'))
            self.assertFalse((Path(root)/'data').exists())


class OfficialQQTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.client=OfficialQQ(config(self.root));self.owner=Owner();self.client.ws=self.owner
        self.client._apply_status(status())

    async def asyncTearDown(self):
        await self.client.close();self.temp.cleanup()

    def incoming(self, **kwargs):
        event=self.client._message(message(**kwargs))
        return event,('g'+str(event['group_id']) if event.get('group_id') else 'p'+str(event['user_id']))

    async def test_group_at_normalization_observed_lists_and_no_implicit_member_role(self):
        event,key=self.incoming()
        self.assertEqual(event['message'][0],{'type':'at','data':{'qq':self.client.self_id}})
        plain,_=self.incoming(mid='sdk-no-at',rawEventType='GROUP_MESSAGE_CREATE')
        self.assertFalse(any(p['type']=='at' for p in plain['message']))
        groups=await self.client.api('get_group_list');friends=await self.client.api('get_friend_list')
        self.assertEqual(groups[0]['officialOpenId'],'opaque-group');self.assertTrue(groups[0]['observedOnly'])
        self.assertEqual(friends,[])
        observed=await self.client.api('get_msg',{'message_id':event['message_id']})
        self.assertEqual(observed['_official']['messageId'],'sdk-msg-1')
        with self.assertRaises(OneBotError):await self.client.member(event['group_id'],event['user_id'])
        rows=self.client.identity_rows();self.assertTrue(any(r['kind']=='group-user' and r['openId']=='opaque-user' for r in rows))
        self.assertNotIn(TOKEN,json.dumps(self.client.metadata()))

    async def test_binding_phases_follow_bridge_contract_and_do_not_expose_secrets_or_svg(self):
        for phase in ['unbound','qr','bound','connecting','online','error','canceled']:
            value=status();value['binding']={'phase':phase,'appSecret':'fixture-secret','qrDataUrl':'data:image/svg+xml;base64,PHN2Zz4='}
            self.client._apply_status(value)
            self.assertEqual(self.client.metadata()['binding'],{'phase':phase})
        value=status();value['binding']={'phase':'qr','qrDataUrl':'data:image/png;base64,'+base64.b64encode(PNG).decode()}
        self.client._apply_status(value)
        self.assertEqual(self.client.metadata()['binding'],value['binding'])

    async def test_binding_refresh_metadata_and_links_remain_constrained(self):
        value = status()
        value['binding'] = {'phase':'preparing'}
        self.client._apply_status(value)
        self.assertEqual(self.client.metadata()['binding'], {'phase':'preparing'})
        binding = {'phase':'qr', 'qrDataUrl':'data:image/png;base64,'+base64.b64encode(PNG).decode(),
                   'qrUrl':'https://q.qq.com/qqbot/openclaw/connect.html?task_id=fixture',
                   'issuedAt':1000000, 'refreshAt':1120000}
        value['binding'] = binding
        self.client._apply_status(value)
        self.assertEqual(self.client.metadata()['binding'], binding)
        value['binding'] = {**binding, 'qrUrl':'https://evil.invalid/qqbot/openclaw/connect.html', 'issuedAt':float('inf')}
        self.client._apply_status(value)
        self.assertNotIn('qrUrl', self.client.metadata()['binding'])
        self.assertNotIn('issuedAt', self.client.metadata()['binding'])
        value['binding'] = {'phase':'error', 'message':'retry', 'appSecret':'private', 'qrUrl':binding['qrUrl']}
        self.client._apply_status(value)
        self.assertEqual(self.client.metadata()['binding'], {'phase':'error','message':'retry'})

    async def test_duplicate_incoming_message_does_not_reset_quota_or_dispatch_again(self):
        delivered=[]
        async def handler(event):delivered.append(event)
        self.client.on_event=handler
        incoming=message()
        self.client.receive(incoming,self.owner)
        await asyncio.sleep(0)
        self.client.latest[('group','opaque-group')]['uses']=4
        self.client.receive(incoming,self.owner)
        await asyncio.sleep(0)
        self.assertEqual(len(delivered),1)
        self.assertEqual(self.client.latest[('group','opaque-group')]['uses'],4)

    async def test_actual_sdk_receipt_maps_to_confirmed_handle_and_only_own_recall(self):
        event,key=self.incoming();requests=[]
        async def bridge(action,params=None,timeout=None):
            requests.append((action,copy.deepcopy(params)))
            return {'messageId':'sdk-confirmed-opaque'} if action=='qq.send' else {'deleted':True}
        self.client._bridge=bridge
        result=await self.client.send(key,'fixture answer')
        self.assertIsNotNone(confirmed_message_id(result))
        self.assertEqual(result['officialMessageId'],'sdk-confirmed-opaque')
        self.assertEqual(requests[0][1]['targetId'],'opaque-group')
        self.assertEqual(requests[0][1]['msgId'],'sdk-msg-1')
        with self.assertRaises(ValueError):await self.client.api('delete_msg',{'message_id':event['message_id']})
        await self.client.api('delete_msg',{'message_id':result['message_id']})
        self.assertEqual(requests[-1][1],{'scope':'group','targetId':'opaque-group','messageId':'sdk-confirmed-opaque'})
        with self.assertRaises(OneBotError):await self.client.api('delete_msg',{'message_id':result['message_id']})

    async def test_unknown_or_missing_receipt_never_creates_confirmation_or_retries(self):
        _,key=self.incoming();calls=[]
        async def unknown(action,params=None,timeout=None):
            calls.append(action);raise OneBotError('fixture unknown',outcome_unknown=True)
        self.client._bridge=unknown
        with self.assertRaises(OneBotError) as error:await self.client.send(key,'answer')
        self.assertTrue(error.exception.outcome_unknown);self.assertEqual(calls,['qq.send'])
        self.assertFalse(any(r['kind']=='outgoing-message' for r in self.client.registry.data['rows']))
        async def missing(*args,**kwargs):calls.append('missing');return {}
        self.client._bridge=missing
        with self.assertRaises(OneBotError) as error:await self.client.send(key,'answer')
        self.assertTrue(error.exception.outcome_unknown)
        self.assertFalse(any(r['kind']=='outgoing-message' for r in self.client.registry.data['rows']))

    async def test_unsupported_and_proactive_requests_never_touch_bridge(self):
        _,key=self.incoming();calls=[]
        async def bridge(*args,**kwargs):calls.append(args);return {'messageId':'unexpected'}
        self.client._bridge=bridge
        for action in ['get_group_member_info','get_group_msg_history','get_group_member_list','set_group_ban','group_poke','send_group_forward_msg','upload_group_file']:
            with self.subTest(action=action),self.assertRaises(OneBotError) as error:await self.client.api(action,{})
            self.assertEqual(error.exception.code,'OFFICIAL_UNSUPPORTED')
        with self.assertRaises(OneBotError):await self.client.send(key,[{'type':'music','data':{'id':'1'}}])
        self.client.latest.clear()
        with self.assertRaises(OneBotError):await self.client.send(key,'no passive target')
        self.assertEqual(calls,[])

    async def test_group_c2c_passive_windows_and_four_dispatch_limit(self):
        _,group=self.incoming();_,private=self.incoming(kind='c2c',mid='private-msg')
        async def bridge(*args,**kwargs):return {'messageId':'receipt-'+str(time.monotonic_ns())}
        self.client._bridge=bridge
        self.client.latest[('group','opaque-group')]['at']=time.time()-301
        with self.assertRaises(OneBotError):await self.client.send(group,'expired')
        self.client.latest[('c2c','opaque-user')]['at']=time.time()-1790
        for _ in range(4):await self.client.send(private,'answer')
        with self.assertRaises(OneBotError):await self.client.send(private,'fifth')

    async def test_disconnect_and_app_change_invalidate_timeline_and_targets(self):
        event,key=self.incoming();self.assertTrue(self.client.timeline.current(event))
        self.client.disconnected(self.owner)
        self.assertFalse(self.client.online);self.assertEqual(self.client.latest,{})
        self.assertFalse(self.client.timeline.current(event))
        self.client.ws=self.owner;self.client._apply_status(status())
        original=(self.client.config.data_dir/'qq-official-profile.json').read_bytes()
        self.client.receive({'type':'qq-status','data':status('different-app')},self.owner)
        await asyncio.sleep(0)
        self.assertFalse(self.client.online);self.assertTrue(self.client.stopping)
        self.assertEqual((self.client.config.data_dir/'qq-official-profile.json').read_bytes(),original)

    async def test_images_allow_verified_inline_or_owned_files_and_reject_remote_external_mixed(self):
        _,key=self.incoming();calls=[]
        async def bridge(action,params=None,timeout=None):calls.append(params);return {'messageId':'image-receipt'}
        self.client._bridge=bridge
        inline='data:image/png;base64,'+base64.b64encode(PNG).decode()
        segment=await self.client.image_segment(inline,sticker=True)
        await self.client.send(key,[segment]);self.assertEqual(calls[0]['segments'][0]['mime'],'image/png')
        owned=self.client.config.data_dir/'stickers'/'fixture.png';owned.parent.mkdir();owned.write_bytes(PNG)
        await self.client.image_segment(owned.as_uri())
        external=self.root/'external.png';external.write_bytes(PNG)
        for path in [external.as_uri(),'https://example.invalid/image.png','data:image/jpeg;base64,'+base64.b64encode(PNG).decode()]:
            with self.subTest(path=path[:30]),self.assertRaises(ValueError):await self.client.image_segment(path)
        with self.assertRaises(OneBotError):await self.client.send(key,[{'type':'text','data':{'text':'x'}},segment])

    async def test_real_loopback_ws_health_ignores_missing_server_roster_and_errors_preserve_unknown(self):
        await self.client.close();requests=[];active=[];online=asyncio.Event()
        async def websocket(request):
            self.assertEqual(request.headers.get('Authorization'),'Bearer '+TOKEN)
            connection=web.WebSocketResponse();await connection.prepare(request);active.append(connection)
            async for frame in connection:
                item=frame.json();requests.append(item['action'])
                if item['action']=='qq.status':
                    await connection.send_json({'echo':item['echo'],'status':'ok','retcode':0,'data':status()})
                    online.set()
                elif item['action']=='qq.send':
                    await connection.send_json({'echo':item['echo'],'status':'failed','retcode':1,'code':'SDK_UNKNOWN','outcomeUnknown':True,'message':'do-not-surface-provider-details'})
            return connection
        app=web.Application();app.router.add_get('/bridge',websocket)
        async with TestServer(app) as server:
            c=config(self.root,QQ_OFFICIAL_BRIDGE_URL=str(server.make_url('/bridge')).replace('http:','ws:'))
            client=OfficialQQ(c);task=asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(online.wait(),3)
                for _ in range(30):
                    if client.online:break
                    await asyncio.sleep(.01)
                self.assertTrue(client.online);self.assertTrue(client.probe_verified)
                self.assertEqual(requests,['qq.status'])
                e=client._message(message());key='g'+str(e['group_id'])
                with self.assertRaises(OneBotError) as error:await client.send(key,'fixture')
                self.assertTrue(error.exception.outcome_unknown);self.assertNotIn('provider-details',str(error.exception))
                self.assertEqual(requests.count('qq.send'),1)
            finally:
                await client.close();await asyncio.wait_for(task,3)
            self.assertTrue(all(ws.closed for ws in active))
