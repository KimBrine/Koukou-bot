import asyncio
import unittest
from unittest.mock import patch
from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer
from koukou.models import ModelClient, ModelError
from koukou.onebot import OneBot


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_stream_has_idle_timeout_without_total_deadline(self):
        requests = []
        async def reply(request):
            import json
            requests.append(await request.json())
            response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
            await response.prepare(request)
            for index in range(5):
                value = {'choices': [{'delta': {'reasoning_content': '思考中'}, 'finish_reason': None}]}
                await response.write(('data: '+json.dumps(value)+'\n\n').encode())
                await asyncio.sleep(.07)
            await response.write(('data: '+json.dumps({'choices': [{'delta': {'content': '完整答复'}, 'finish_reason': 'stop'}]}, ensure_ascii=False)+'\n\n').encode())
            return response
        app = web.Application(); app.router.add_post('/v1/chat/completions', reply)
        server = TestServer(app); await server.start_server()
        try:
            async with ClientSession() as http:
                model = ModelClient(http, api_key='test-only', base_url=str(server.make_url('/v1')), timeout=.2, max_tokens=1, retries=0)
                self.assertEqual(await model.chat('', [], unlimited=True, stream=True), '完整答复')
                self.assertNotIn('max_tokens', requests[0]); self.assertEqual(requests[0]['reasoning_effort'], 'max')
        finally:
            await server.close()

    async def test_stream_disconnect_does_not_return_partial_reply(self):
        async def reply(request):
            return web.Response(text='data: {"choices":[{"delta":{"content":"半句话"},"finish_reason":null}]}\n\n', content_type='text/event-stream')
        app = web.Application(); app.router.add_post('/v1/chat/completions', reply)
        server = TestServer(app); await server.start_server()
        try:
            async with ClientSession() as http:
                model = ModelClient(http, api_key='test-only', base_url=str(server.make_url('/v1')), retries=0)
                with self.assertRaisesRegex(ModelError, '提前中断'):
                    await model.chat('', [], unlimited=True, stream=True)
        finally:
            await server.close()

    async def test_real_http_model_retry_preserves_max(self):
        requests = []
        async def reply(request):
            body = await request.json(); requests.append(body)
            if len(requests) == 1:
                return web.json_response({"error": {"code": "temporary"}}, status=500)
            return web.json_response({"choices": [{"finish_reason": "stop", "message": {"content": "完整答复"}}]})
        app = web.Application(); app.router.add_post("/v1/chat/completions", reply)
        server = TestServer(app); await server.start_server()
        try:
            async with ClientSession() as http:
                model = ModelClient(http, api_key="test-only", base_url=str(server.make_url("/v1")), retries=1)
                self.assertEqual(await model.chat("system", [{"role": "user", "content": "你好"}]), "完整答复")
            self.assertEqual([r["reasoning_effort"] for r in requests], ["max", "max"])
        finally:
            await server.close()

    async def test_model_auth_failure_and_truncation_are_not_retried(self):
        calls = []
        async def reply(request):
            calls.append(1)
            if len(calls) == 1:
                return web.json_response({"error": {"code": "bad_key"}}, status=401)
            return web.json_response({"choices": [{"finish_reason": "length", "message": {"content": "半句话"}}]})
        app = web.Application(); app.router.add_post("/v1/chat/completions", reply)
        server = TestServer(app); await server.start_server()
        try:
            async with ClientSession() as http:
                model = ModelClient(http, api_key="test-only", base_url=str(server.make_url("/v1")))
                with self.assertRaises(ModelError):
                    await model.chat("", [])
                self.assertEqual(len(calls), 1)
                with self.assertRaisesRegex(ModelError, "截断"):
                    await model.chat("", [])
                self.assertEqual(len(calls), 2)
        finally:
            await server.close()

    async def test_success_http_status_cannot_hide_content_filter_or_bad_message(self):
        payloads=[{'choices':[{'finish_reason':'content_filter','message':{'content':'不能转发的部分'}}]},
                  {'error':{'code':'data_inspection_failed','message':'private provider echo'}},
                  {'choices':[{'finish_reason':'stop','message':{'content':['bad shape']}}]}]
        calls=[]
        async def reply(request):
            calls.append(1)
            return web.json_response(payloads[0])
        app=web.Application();app.router.add_post('/v1/chat/completions',reply)
        async with TestServer(app) as server,ClientSession(trust_env=False) as http:
            model=ModelClient(http,api_key='test-only',base_url=str(server.make_url('/v1')),retries=2)
            for _ in range(2):
                with self.assertRaises(ModelError) as raised:await model.chat('',[])
                self.assertEqual(raised.exception.status,400)
                self.assertNotIn('private provider echo',str(raised.exception))
                payloads.pop(0)
            self.assertEqual(len(calls),2)
            model.retries=0
            with self.assertRaisesRegex(ModelError,'格式无效'):await model.chat('',[])
            self.assertEqual(len(calls),3)

    async def test_real_loopback_websocket_onebot_echo_and_shutdown(self):
        actions, connected = [], asyncio.Event()
        async def endpoint(request):
            socket = web.WebSocketResponse(); await socket.prepare(request)
            async for frame in socket:
                data = frame.json(); action = data["action"]; actions.append(action)
                value = {"online": True} if action == "get_status" else {"user_id": 200000010} if action == "get_login_info" else [] if action == "get_group_list" else {"message_id": 9}
                await socket.send_json({"echo": data["echo"], "status": "ok", "retcode": 0, "data": value})
                if action == "get_group_list":
                    connected.set()
            return socket
        app = web.Application(); app.router.add_get("/", endpoint)
        server = TestServer(app); await server.start_server()
        bot = OneBot(str(server.make_url("/")).replace("http://", "ws://"))
        task = asyncio.create_task(bot.run())
        try:
            await asyncio.wait_for(connected.wait(), 3)
            for _ in range(20):
                if bot.probe_verified:
                    break
                await asyncio.sleep(.01)
            self.assertTrue(bot.status()["online"])
            self.assertEqual((await bot.send("g200000002", "仅发往本地测试WebSocket"))["message_id"], 9)
            self.assertEqual(actions.count("send_group_msg"), 1)
        finally:
            await bot.close()
            await asyncio.wait_for(task, 3)
            await server.close()


if __name__ == "__main__":
    unittest.main()
