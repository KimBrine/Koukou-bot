"""Full native pipeline against loopback HTTP/WS, never an actual provider or QQ."""
import asyncio
import json
from datetime import datetime, timezone, timedelta
import tempfile
import time
import unittest

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer
from koukou.config import Config
from koukou.runtime import Runtime


class RuntimeFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.calls=[];self.prompts=[];self.socket=None;self.model_reply='这是完整的本地回答。'
        self.slow=False;self.entered=asyncio.Event();self.release=asyncio.Event()
        self.roles={200000010:'admin',200000011:'admin',200000012:'member'}
        async def model(request):
            body=await request.json();self.prompts.append(body)
            self.assertEqual(request.headers['Authorization'],'Bearer loopback-only')
            self.assertEqual(body['reasoning_effort'],'max')
            if self.slow:
                self.entered.set();await self.release.wait()
            return web.json_response({'choices':[{'message':{'content':self.model_reply},'finish_reason':'stop'}]})
        async def websocket(request):
            ws=web.WebSocketResponse();await ws.prepare(request);self.socket=ws
            async for frame in ws:
                data=frame.json();action=data['action'];params=data['params'];self.calls.append((action,params))
                if action=='get_status':value={'online':True}
                elif action=='get_login_info':value={'user_id':200000010}
                elif action=='get_group_list':value=[{'group_id':200000002,'group_name':'本地测试群'}]
                elif action=='get_group_member_info':value={'user_id':params['user_id'],'role':self.roles[params['user_id']],'nickname':'测试成员'}
                elif action in {'send_group_msg','send_private_msg'}:value={'message_id':1000+len(self.calls)}
                elif action in {'set_group_ban','forward_group_single_msg'}:value={}
                else:raise AssertionError('Unexpected loopback action: '+action)
                await ws.send_json({'echo':data['echo'],'status':'ok','retcode':0,'data':value})
            return ws
        app=web.Application();app.router.add_post('/v1/chat/completions',model);app.router.add_get('/ws',websocket)
        self.server=TestServer(app);await self.server.start_server()
        self.config=Config(self.temp.name,environ={'DEEPSEEK_API_KEY':'loopback-only','DEEPSEEK_MODEL':'deepseek-flash',
            'DEEPSEEK_BASE_URL':str(self.server.make_url('/v1')),'ONEBOT_WS_URL':str(self.server.make_url('/ws')).replace('http:','ws:'),
            'WHITELIST_GROUPS':'200000002','PRIVATE_WHITELIST':'200000011','ADMIN_USERS':'200000011',
            'PROACTIVE_RATE':'0','EMOJI_KEEP_RATE':'0','WEB_SEARCH_ENABLED':'0','STICKER_SEND_RATE':'0',
            'HUMAN_DELAY_MIN_MS':'0','HUMAN_DELAY_MAX_MS':'0','LINE_GAP_MIN_MS':'0','LINE_GAP_MAX_MS':'0','RATE_LIMIT_MIN_GAP_MS':'0'})
        self.runtime=await Runtime.create(self.config)
        await self.runtime.start(connect=True)
        await self.until(lambda:self.runtime.onebot.online)
        self.console=TestServer(self.runtime.admin.app());await self.console.start_server()
        self.http=ClientSession(trust_env=False)

    async def asyncTearDown(self):
        self.release.set()
        await self.http.close();await self.console.close();await self.runtime.close();await self.server.close()
        self.temp.cleanup()

    async def until(self,predicate):
        async with asyncio.timeout(3):
            while not predicate():await asyncio.sleep(.005)

    async def publish(self,text,*,id=1,private=False,mention=None,at=True):
        message=[{'type':'text','data':{'text':text}}]
        if not private and at:message.insert(0,{'type':'at','data':{'qq':'200000010'}})
        if mention:message.append({'type':'at','data':{'qq':str(mention)}})
        event={'self_id':200000010,'post_type':'message','message_type':'private' if private else 'group',
               'user_id':200000011,'sender':{'nickname':'本地提问者'},'message_id':id,'time':time.time(),'message':message}
        if not private:event['group_id']=200000002
        await self.socket.send_json(event)
        return event

    async def drain(self):
        # A local status round-trip establishes that earlier frames were consumed.
        await self.runtime.onebot.api('get_status')
        await self.until(lambda:not self.runtime.onebot.tasks)

    async def action(self,name,payload):
        async with self.http.post(self.console.make_url('/api/action/'+name),json=payload,
                headers={'X-Admin-Token':self.runtime.admin.token}) as response:
            data=await response.json();self.assertEqual(response.status,200,data);return data

    def sent(self):
        result=[]
        for action,params in self.calls:
            if action in {'send_group_msg','send_private_msg'}:
                body=params['message']
                result.append(body if isinstance(body,str) else ''.join(s['data'].get('text','') for s in body if s['type']=='text'))
        return result

    async def test_private_q_uses_actual_http_and_ws_preserving_full_answer(self):
        self.model_reply='1. 认真解释\n'+('保留汉字𠀀和💀\n'*450)+'```python\n    print("缩进")\n```'
        await self.publish('/Q 请详细说明',private=True);await self.drain()
        self.assertEqual(''.join(self.sent()),self.model_reply)
        self.assertGreater(len(self.sent()),1)
        self.assertNotIn('max_tokens',self.prompts[0])
        self.assertEqual(len(self.runtime.rate_limiter.history['p200000011']),1)
        self.assertTrue(all(v['status']=='confirmed' for v in self.runtime.bot.reply_receipts.values()))

    async def test_new_chat_does_not_cancel_accepted_reply_or_change_its_frozen_question(self):
        self.slow=True
        await self.publish('只回答这个问题');await asyncio.wait_for(self.entered.wait(),3)
        await self.publish('后来的无关聊天',id=2,at=False)
        await self.runtime.onebot.api('get_status')
        self.release.set();await self.drain()
        self.assertEqual(self.sent(),['这是完整的本地回答。'])
        self.assertEqual(len(self.prompts),1)
        self.assertNotIn('后来的无关聊天',json.dumps(self.prompts[0],ensure_ascii=False))

    async def test_http_memory_clear_invalidates_inflight_reply_without_erasing_other_chats(self):
        self.runtime.memory.push('p200000012','user','另外的会话')
        self.slow=True
        await self.publish('等待生成');await asyncio.wait_for(self.entered.wait(),3)
        result=await self.action('clear-memory',{'key':'g200000002'})
        self.assertTrue(result['ok'])
        self.release.set();await self.drain()
        self.assertFalse(self.sent());self.assertEqual(self.runtime.memory.get('g200000002'),[])
        self.assertEqual(self.runtime.memory.get('p200000012')[0]['content'],'另外的会话')

    async def test_http_rule_change_checks_actual_group_role_and_quiet_blocks_actions(self):
        await self.action('save-builtin-command',{'id':'owner-mute','enabled':True,'scope':'group','groups':[200000002]})
        self.model_reply=json.dumps({'intent':'mute','confidence':1.,'executor':'bot','targets':[{'id':'200000012','evidence':'mention'}],'duration':'一分钟'})
        self.roles[200000011]='member'
        await self.publish('禁言这位一分钟',mention=200000012);await self.drain()
        self.assertFalse(any(action=='set_group_ban' for action,_ in self.calls))
        self.roles[200000011]='admin'
        await self.publish('禁言这位一分钟',id=2,mention=200000012);await self.drain()
        bans=[params for action,params in self.calls if action=='set_group_ban']
        self.assertEqual(bans,[{'group_id':200000002,'user_id':200000012,'duration':60}])
        hour=datetime.now(timezone(timedelta(hours=8))).hour
        spec='23:00-01:00' if hour in {23,0} else '00:00-23:59'
        await self.action('set-chat',{'key':'g200000002','patch':{'quietHours':spec}})
        before=(len(self.calls),len(self.prompts))
        await self.publish('禁言这位一分钟',id=3,mention=200000012);await self.drain()
        self.assertEqual(len(self.prompts),before[1])
        self.assertEqual(len([a for a,_ in self.calls if a=='set_group_ban']),1)


if __name__=='__main__':unittest.main()
