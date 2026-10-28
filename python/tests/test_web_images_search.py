"""Offline native web-search/sticker parity and transport regression tests."""
import asyncio
import base64
import gzip
import hashlib
import html
import json
import struct
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit
from aiohttp import ClientSession, web
from koukou.http_client import Response, fetch_public, request
from koukou.image_search import (StaleStickerRequest, build_sticker_query, collect_image_urls,
    collect_web_images, download_image, image_size, parse_bing_image_results, relevant_image_result,
    search_images, sniff_mime)
from koukou.web_sticker import find_web_sticker
from koukou.web_search import WebSearch, create_web_search, decode_bing_url, generate_with_search, parse_bing_results
from koukou.models import ModelClient, ModelError


def response(value, status=200, mime='application/json'):
    data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
    return Response(status, data, {'content-type': mime})


def png(width=200, height=220, seed=b'a', size=9000):
    return b'\x89PNG\r\n\x1a\n'+b'\0'*8+struct.pack('>II', width, height)+seed*(size-24)


def image_html(items):
    return ''.join('<a m="'+html.escape(json.dumps({'murl': url, 't': title, 'purl': 'https://page.invalid'}), quote=True)+'">' for url, title in items)


class PureImageTests(unittest.TestCase):
    def test_parsing_query_mime_dimensions_and_relevance(self):
        self.assertEqual(build_sticker_query('给我找张开心的表情包'), '开心 表情包')
        self.assertEqual(build_sticker_query('随便表情包'), '聊天 表情包')
        self.assertEqual(build_sticker_query('奶龙'), '奶龙 表情包')
        document = image_html([('https://a.invalid/a.png', '奶龙开心'), ('https://a.invalid/a.png', '重复'), ('file:///bad.png', '无效')])+'<a m="broken">'
        self.assertEqual(parse_bing_image_results(document), [{'url':'https://a.invalid/a.png','title':'奶龙开心','pageUrl':'https://page.invalid'}])
        self.assertEqual(image_size(png()), {'width':200,'height':220})
        self.assertEqual(sniff_mime(png()), 'image/png')
        self.assertEqual(sniff_mime(b'GIF89a'+b'\0'*30), 'image/gif')
        self.assertEqual(image_size(b'GIF89a'+struct.pack('<HH', 8, 10)+b'\0'*10), {'width':8,'height':10})
        jpeg = b'\xff\xd8\xff\xc0\0\x11\x08'+struct.pack('>HH', 240, 320)+b'\0'*20
        self.assertEqual(image_size(jpeg), {'width':320,'height':240})
        webp = b'RIFF'+b'\0'*4+b'WEBPVP8X'+b'\0'*8+(300-1).to_bytes(3,'little')+(200-1).to_bytes(3,'little')
        self.assertEqual(image_size(webp), {'width':300,'height':200})
        self.assertEqual(sniff_mime(webp), 'image/webp')
        self.assertIsNone(image_size(b'\xff\xd8\xff\xc0\0\0'))
        self.assertTrue(relevant_image_result({'title':'奶龙开心聊天表情包'}, '奶龙 开心 表情包'))
        self.assertFalse(relevant_image_result({'title':'商品风景图'}, '奶龙 开心 表情包'))
        self.assertTrue(relevant_image_result({}, '任意'))
        self.assertEqual(collect_image_urls({'url':'https://x.invalid/a.jpg?size=2', 'bad':'file:///b.jpg', 'nested':[['https://x.invalid/b.webp']]}), ['https://x.invalid/a.jpg?size=2','https://x.invalid/b.webp'])
        self.assertEqual(len(collect_image_urls(['https://x.invalid/a.png']*100)), 40)

    def test_text_result_decoding(self):
        real = 'https://example.invalid/中文?q=1&x=2'
        encoded = base64.urlsafe_b64encode(real.encode()).decode().rstrip('=')
        self.assertEqual(decode_bing_url('/ck/a?u=a1'+encoded), real)
        page = '<li class="b_algo"><h2><a href="/ck/a?u=a1'+encoded+'">标题 &amp; <b>新闻</b></a></h2><p>段落 <script>secret</script>正文</p>'
        expected = [{'title':'标题 & 新闻','url':real,'date':'','snippet':'段落 正文'}]
        self.assertEqual(parse_bing_results(page+page), expected)


class ImageProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_six_providers_and_custom_encoding(self):
        seen = []
        async def fetch(url, **options):
            seen.append((url, options))
            host = urlsplit(url).hostname
            if host == 'www.bing.com':
                return response(image_html([('https://cdn.invalid/bing.png','奶龙')]).encode(), mime='text/html')
            if host == 'image.baidu.com':
                return response({'data':[{'middleURL':'https://cdn.invalid/baidu.png','fromPageTitle':'<b>奶龙</b>&amp;开心'}, None]})
            if host == 'image.so.com':
                return response({'list':[{'img':'https://cdn.invalid/so.gif','title':'奶龙'}]})
            if host == 'api.giphy.com':
                return response({'data':[{'images':{'fixed_width':{'url':'https://cdn.invalid/small.gif'},'original':{'url':'https://cdn.invalid/large.gif'}}}]})
            if host == 'tenor.googleapis.com':
                return response({'results':[{'media_formats':{'tinygif':{'url':'https://cdn.invalid/tiny.gif'}}}]})
            return response({'nested':{'url':'https://cdn.invalid/custom.png'}, 'duplicate':'https://cdn.invalid/custom.png'})
        expected = {'bing':'bing.png','baidu':'baidu.png','so':'so.gif','giphy':'small.gif','tenor':'tiny.gif','custom':'custom.png'}
        for provider, name in expected.items():
            rows = await search_images('奶龙 & 开心', provider=provider, url_template='https://custom.invalid/images?q={query}&key={key}&n={count}', key='key &?', count=99, fetch=fetch)
            self.assertEqual(rows[0]['url'], 'https://cdn.invalid/'+name)
        custom_url, options = seen[-1]
        self.assertEqual(parse_qs(urlsplit(custom_url).query), {'q':['奶龙 & 开心'],'key':['key &?'],'n':['35']})
        self.assertTrue(options['configured'])
        self.assertEqual(len(await search_images('x', provider='custom', url_template='https://custom.invalid/', fetch=fetch)), 1)
        for provider in ['giphy','tenor']:
            with self.assertRaisesRegex(ValueError, 'API Key'):
                await search_images('x', provider=provider, fetch=fetch)

    async def test_download_limits_and_content_not_header(self):
        async def good(url, **options):
            self.assertEqual(options['maximum'], 10000)
            return response(png(), mime='text/html')
        value = await download_image('https://cdn.invalid/x.png', max_bytes=10000, min_side=160, fetch=good)
        self.assertEqual(value['mime'], 'image/png')
        self.assertEqual(base64.b64decode(value['dataUrl'].split(',')[1]), value['buffer'])
        for data, error in [(b'not an image'*1000, '支持'), (png(size=100), '太小'), (png(width=12), '尺寸太小'), (png(size=11000), '太大')]:
            async def bad(url, data=data, **options):
                return response(data, mime='image/png')
            with self.assertRaisesRegex(ValueError, error):
                await download_image('https://cdn.invalid/x.png', min_side=160, max_bytes=10000, fetch=bad)

    async def test_candidate_round_robin_hash_dedup_relevance_and_stale(self):
        downloaded, diagnostics = [], []
        async def fetch(url, **options):
            if urlsplit(url).hostname == 'www.bing.com':
                query = parse_qs(urlsplit(url).query)['q'][0]
                return response(image_html([(f'https://cdn.invalid/{query}1.png',query), (f'https://cdn.invalid/{query}2.png',query), ('https://cdn.invalid/irrelevant.png','商品风景')]).encode())
            downloaded.append(url)
            data = png(seed=b'b') if '猫猫1' in url else png(seed=b'a')
            return response(data)
        rows = await collect_web_images(['奶龙','猫猫','奶龙'], count=3, limit=3, fetch=fetch, on_diagnostic=diagnostics.append)
        self.assertEqual([row['query'] for row in rows], ['奶龙','猫猫'])
        self.assertEqual(downloaded[:2], ['https://cdn.invalid/奶龙1.png','https://cdn.invalid/猫猫1.png'])
        self.assertEqual(sum(event['stage']=='search' for event in diagnostics), 2)
        self.assertEqual(sum(event['stage']=='irrelevant' for event in diagnostics), 1)
        active = True
        async def stale(url, **options):
            nonlocal active
            out = await fetch(url, **options)
            if urlsplit(url).hostname == 'cdn.invalid':
                active = False
            return out
        with self.assertRaises(StaleStickerRequest):
            await collect_web_images(['奶龙'], fetch=stale, current=lambda: active)

    async def test_diagnostics_do_not_echo_custom_keys(self):
        events = []
        async def fail(url, **options):
            raise ValueError('failure https://x.invalid?key=verysecret verysecret')
        self.assertEqual(await collect_web_images(['x'], provider='custom', key='verysecret', url_template='https://x.invalid?key={key}', fetch=fail, on_diagnostic=events.append), [])
        self.assertNotIn('verysecret', json.dumps(events))

    async def test_stale_parallel_search_cancels_and_joins_siblings(self):
        active = True
        slow_started, slow_closed = asyncio.Event(), asyncio.Event()
        async def fetch(url, **options):
            nonlocal active
            query = parse_qs(urlsplit(url).query)['q'][0]
            if query == 'slow':
                slow_started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    slow_closed.set()
            await slow_started.wait()
            active = False
            return response(b'')
        with self.assertRaises(StaleStickerRequest):
            await collect_web_images(['slow', 'stale'], fetch=fetch, current=lambda:active)
        self.assertTrue(slow_closed.is_set())


class WebStickerTests(unittest.IsolatedAsyncioTestCase):
    def candidate(self, key='a'):
        buffer = png(seed=key.encode())
        return {'buffer': buffer, 'mime':'image/png', 'size':{'width':200,'height':220}, 'hash': hashlib.sha256(buffer).hexdigest(), 'title':'奶龙 开心', 'dataUrl':'data:image/png;base64,'+base64.b64encode(buffer).decode(), 'sourceUrl':'https://x.invalid/a.png','query':'奶龙 开心 表情包'}

    async def test_rewrite_and_independent_review_with_no_library_admission(self):
        llm = type('LLM', (), {'chat':AsyncMock(return_value='1. 奶龙 开心 表情包\n2、奶龙 大笑 贴纸')})()
        vision = type('Vision', (), {'describe':AsyncMock(side_effect=['否，普通插画','是，奶龙聊天反应'])})()
        with patch('koukou.web_sticker.collect_web_images', AsyncMock(return_value=[self.candidate('a'),self.candidate('b')])) as collect:
            image = await find_web_sticker(text='给我奶龙开心表情包', config={}, llm=llm, vision=vision)
        self.assertEqual(image['hash'], self.candidate('b')['hash'])
        self.assertEqual(collect.await_args.args[0][:2], ['奶龙 开心 表情包','奶龙 大笑 贴纸'])
        self.assertTrue(llm.chat.await_args.kwargs['unlimited'])
        self.assertEqual(vision.describe.await_count, 2)
        self.assertTrue(all(call.kwargs['unlimited'] for call in vision.describe.await_args_list))
        self.assertEqual(vision.describe.await_args.args[2], [image['dataUrl']])

    async def test_filter_requires_model_and_recheck_blocklist_after_review(self):
        with self.assertRaisesRegex(ValueError, '复核模型不可用'):
            await find_web_sticker(text='猫猫', config={})
        blocked = set()
        image = self.candidate()
        async def review(*args, **options):
            blocked.add(image['hash'])
            return '是，聊天反应'
        vision = type('Vision', (), {'describe':staticmethod(review)})()
        with patch('koukou.web_sticker.collect_web_images', AsyncMock(return_value=[image])):
            with self.assertRaisesRegex(ValueError, '黑名单'):
                await find_web_sticker(text='奶龙', config={}, vision=vision, is_blocked=blocked.__contains__)
        with patch('koukou.web_sticker.collect_web_images', AsyncMock(return_value=[image])) as collect:
            out = await find_web_sticker(text='奶龙', config={'STICKER_SEARCH_FILTER':'0','STICKER_SEARCH_PROVIDER':'custom','STICKER_SEARCH_PROXY':'http://proxy.invalid'})
            self.assertEqual(out['hash'], image['hash'])
            self.assertEqual(collect.await_args.kwargs['proxy'], 'http://proxy.invalid')

    async def test_review_errors_never_pass_and_auth_errors_propagate(self):
        vision = type('Vision', (), {'describe':AsyncMock(side_effect=ModelError('unavailable', 503))})()
        with patch('koukou.web_sticker.collect_web_images', AsyncMock(return_value=[self.candidate()])):
            with self.assertRaisesRegex(ValueError, '复核'):
                await find_web_sticker(text='奶龙', config={}, vision=vision)
        vision.describe = AsyncMock(side_effect=ModelError('auth', 401))
        with patch('koukou.web_sticker.collect_web_images', AsyncMock(return_value=[self.candidate()])):
            with self.assertRaises(ModelError):
                await find_web_sticker(text='奶龙', config={}, vision=vision)

    async def test_stale_after_rewrite_and_review(self):
        active = True
        async def rewrite(*args, **options):
            nonlocal active
            active = False
            return '猫猫 表情包'
        with self.assertRaises(StaleStickerRequest):
            await find_web_sticker(text='猫猫', config={}, llm=type('L', (), {'chat':staticmethod(rewrite)})(), current=lambda: active)
        active = True
        async def review(*args, **options):
            nonlocal active
            active = False
            return '是，符合'
        with patch('koukou.web_sticker.collect_web_images', AsyncMock(return_value=[self.candidate()])):
            with self.assertRaises(StaleStickerRequest):
                await find_web_sticker(text='奶龙', config={}, vision=type('V', (), {'describe':staticmethod(review)})(), current=lambda: active)


class SearchProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_auto_priorities_cache_ttl_capacity_and_empty(self):
        self.assertEqual(WebSearch(api_key='x', deepseek_api_key='x', dashscope_api_key='x').provider_name, 'baidu')
        self.assertEqual(WebSearch(deepseek_api_key='x', dashscope_api_key='x').provider_name, 'deepseek')
        self.assertEqual(WebSearch(dashscope_api_key='x').provider_name, 'dashscope')
        self.assertEqual(WebSearch().provider_name, 'bing')
        self.assertIsNone(create_web_search(provider='off'))
        self.assertIsNone(WebSearch.from_config({'WEB_SEARCH_ENABLED':'0'}))
        for mode in ['deepseek','dashscope','baidu','bad']:
            with self.assertRaises(ValueError):
                WebSearch(provider=mode)
        now, calls = [0], []
        async def fetch(url, **options):
            calls.append((url, options))
            return response({'results':[{'title':'结果','url':'https://source.invalid','summary':'描述'}]})
        search = WebSearch(provider='deepseek', deepseek_api_key='secret', fetch=fetch, now=lambda:now[0])
        first = await search(' query ')
        first['summary'] = 'mutated'
        self.assertNotEqual((await search('query'))['summary'], 'mutated')
        self.assertEqual(len(calls), 1)
        now[0] = 601
        await search('query')
        self.assertEqual(len(calls), 2)
        for i in range(55):
            await search(str(i))
        self.assertEqual(len(search.cache), 50)
        self.assertNotIn('query', search.cache)
        self.assertEqual(await search(''), {'summary':'','refs':[]})

    async def test_provider_request_shapes_and_safe_errors(self):
        calls = []
        async def fetch(url, **options):
            calls.append((url, options))
            if 'dashscope' in url:
                return response({'output':{'choices':[{'message':{'content':'回答'}}], 'search_info':{'search_results':[{'title':'来源','url':'https://source.invalid'},{'url':'javascript:bad'}]}}})
            if 'deepseek' in url:
                return response({'results':[{'summary':'x'*600,'url':'https://source.invalid'}]})
            if 'qianfan' in url:
                return response({'references':[{'content':'x'*400,'url':'https://source.invalid'}]})
            return response(b'<li class="b_algo"><h2><a href="https://source.invalid">headline</a></h2><p>body</p>')
        for provider, options in [('dashscope',{'dashscope_api_key':'secret'}), ('deepseek',{'deepseek_api_key':'secret'}), ('baidu',{'api_key':'secret'}), ('bing',{})]:
            out = await WebSearch(provider=provider, fetch=fetch, **options)('x'*500)
            self.assertEqual(out['provider'], provider)
            self.assertTrue(out['refs'])
        dash = calls[0][1]['payload']
        self.assertTrue(dash['parameters']['search_options']['forced_search'])
        self.assertEqual(dash['parameters']['max_tokens'], 800)
        self.assertEqual(len(calls[1][1]['payload']['query']), 128)
        self.assertFalse(calls[-1][1]['configured'])
        async def failure(url, **options):
            return response({'error':'secret echoed by provider'}, status=401)
        with self.assertRaisesRegex(ValueError, 'HTTP 401') as error:
            await WebSearch(provider='deepseek', deepseek_api_key='secret', fetch=failure)('x')
        self.assertNotIn('secret', str(error.exception))

    async def test_bing_fallback_host(self):
        urls = []
        async def fetch(url, **options):
            urls.append(url)
            return response(b'empty' if len(urls) == 1 else b'<li class="b_algo"><h2><a href="https://source.invalid">found</a></h2>')
        out = await WebSearch(provider='bing', fetch=fetch)('question')
        self.assertEqual(out['refs'][0]['title'], 'found')
        self.assertTrue(urls[1].startswith('https://www.bing.com/'))

    async def test_deepseek_on_configured_search_model_keeps_max(self):
        async def fetch(url, **options):
            self.assertEqual(options['payload']['parameters']['reasoning_effort'], 'max')
            return response({'output':{'choices':[{'message':{'content':'回答'}}]}})
        await WebSearch(provider='dashscope', dashscope_model='deepseek-v3', dashscope_api_key='fixture-only', fetch=fetch)('question')


class SearchToolTests(unittest.IsolatedAsyncioTestCase):
    def call(self, id, name='web_search', arguments='{"query":"today"}'):
        return {'id':id,'type':'function','function':{'name':name,'arguments':arguments}}

    async def test_all_call_ids_replied_reasoning_preserved_and_round_bounded(self):
        calls = [self.call('one'), self.call('two'), self.call('three'), self.call('four', 'unknown')]
        llm = type('L', (), {'raw':AsyncMock(side_effect=[{'content':'','reasoning_content':'private reason','tool_calls':calls},{'content':'结果回答'}])})()
        search = AsyncMock(return_value={'summary':'事实材料'})
        out = await generate_with_search(llm, search, 'sys', [{'role':'assistant','content':'old'}], 'latest')
        self.assertEqual(out, '结果回答')
        self.assertEqual(search.await_count, 2)
        messages = llm.raw.await_args_list[1].args[1]
        self.assertEqual([msg['tool_call_id'] for msg in messages if msg['role']=='tool'], ['one','two','three','four'])
        self.assertEqual(messages[2]['reasoning_content'], 'private reason')
        self.assertTrue(all(call.kwargs['unlimited'] for call in llm.raw.await_args_list))
        self.assertEqual(llm.raw.await_args_list[0].kwargs['tools'][0]['function']['name'], 'web_search')

    async def test_invalid_unknown_calls_and_failures_have_tool_messages(self):
        calls = [self.call('bad',arguments='invalid'), self.call('unknown',name='other')]
        llm = type('L', (), {'raw':AsyncMock(side_effect=[{'tool_calls':calls},{'content':'无法确定'}])})()
        search = AsyncMock()
        await generate_with_search(llm, search, 'sys', [], 'now')
        search.assert_not_awaited()
        llm.raw = AsyncMock(side_effect=[{'tool_calls':[self.call('fail')]},{'content':'搜索失败'}])
        search = AsyncMock(side_effect=ValueError('https://api.invalid?token=hidden'))
        await generate_with_search(llm, search, 'sys', [], 'now')
        self.assertNotIn('token=', llm.raw.await_args.args[1][-1]['content'])

    async def test_repair_once_blocks_protocol_and_stale(self):
        llm = type('L', (), {'raw':AsyncMock(side_effect=[{'tool_calls':[self.call('one')]},{'content':'<DSML invoke>'},{'content':'正文'}])})()
        self.assertEqual(await generate_with_search(llm, AsyncMock(return_value={'summary':'facts'}), 'sys', [], 'now'), '正文')
        self.assertEqual(llm.raw.await_count, 3)
        llm.raw = AsyncMock(side_effect=[{'tool_calls':[self.call('one')]},{'content':'<tool_call>'},{'content':'<tool_call>'}])
        with self.assertRaisesRegex(ValueError, '已拦截'):
            await generate_with_search(llm, AsyncMock(return_value={'summary':'facts'}), 'sys', [], 'now')
        llm.raw = AsyncMock(return_value={'content':'<think>private'})
        with self.assertRaisesRegex(ValueError, '协议'):
            await generate_with_search(llm, AsyncMock(), 'sys', [], 'now')
        active = True
        async def stale(*args, **kwargs):
            nonlocal active
            active = False
            return {'content':'old reply'}
        llm.raw = AsyncMock(side_effect=stale)
        with self.assertRaisesRegex(ValueError, '失效'):
            await generate_with_search(llm, AsyncMock(), 'sys', [], 'now', current=lambda:active)

    async def test_local_http_model_search_and_retry_preserve_max(self):
        models, searches = [], []
        async def model_reply(req):
            body = await req.json(); models.append(body)
            if len(models) == 1:
                message = {'content':'','reasoning_content':'private reasoning','tool_calls':[self.call('first')]}
            elif len(models) == 2:
                return web.json_response({'error':{'code':'temporary'}}, status=503)
            else:
                self.assertEqual([value['tool_call_id'] for value in body['messages'] if value['role']=='tool'], ['first'])
                self.assertEqual(body['messages'][-2]['reasoning_content'], 'private reasoning')
                message = {'content':'根据搜索材料的完整回答'}
            return web.json_response({'choices':[{'finish_reason':'stop','message':message}]})
        async def search_reply(req):
            searches.append(await req.json())
            return web.json_response({'results':[{'title':'材料','url':'https://source.invalid','summary':'事实'}]})
        app = web.Application(); app.router.add_post('/v1/chat/completions', model_reply); app.router.add_post('/v1/tools/search', search_reply)
        runner = web.AppRunner(app); await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0); await site.start()
        base = 'http://127.0.0.1:'+str(site._server.sockets[0].getsockname()[1])+'/v1'
        try:
            async with ClientSession() as http:
                llm = ModelClient(http, api_key='fixture-only', base_url=base, retries=1, max_tokens=20)
                search = WebSearch(provider='deepseek', deepseek_api_key='fixture-only', deepseek_url=base+'/tools/search')
                self.assertEqual(await generate_with_search(llm, search, 'sys', [], 'today'), '根据搜索材料的完整回答')
            self.assertEqual([body['reasoning_effort'] for body in models], ['max','max','max'])
            self.assertTrue(all('max_tokens' not in body for body in models))
            self.assertEqual(len(searches), 1)
        finally:
            await runner.cleanup()


class HttpTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hits = []
        async def handler(req):
            self.hits.append((req.path, dict(req.headers)))
            if req.path == '/chunked':
                res = web.StreamResponse(); await res.prepare(req)
                await res.write(b'a'*80); await res.write(b'b'*80)
                return res
            if req.path == '/compressed':
                return web.Response(body=gzip.compress(b'a'*1000), headers={'Content-Encoding':'gzip'})
            if req.path == '/same':
                raise web.HTTPFound('/ok')
            if req.path == '/cross':
                raise web.HTTPFound('http://localhost:'+str(self.port)+'/ok')
            if req.path == '/slow':
                await asyncio.sleep(.1)
            return web.json_response({'ok':True})
        app = web.Application(); app.router.add_route('*','/{tail:.*}',handler)
        self.runner = web.AppRunner(app); await self.runner.setup()
        self.site = web.TCPSite(self.runner, '127.0.0.1', 0); await self.site.start()
        self.port = self.site._server.sockets[0].getsockname()[1]
        self.url = 'http://127.0.0.1:'+str(self.port)

    async def asyncTearDown(self):
        await self.runner.cleanup()

    async def test_public_policy_rejects_local_while_configured_endpoint_works(self):
        for url in [self.url+'/ok','http://localhost/ok','http://[::1]/ok','http://169.254.169.254/metadata','file:///secret','http://u:p@public.invalid']:
            with self.assertRaises(ValueError):
                await fetch_public(url)
        self.assertEqual(self.hits, [])
        out = await request(self.url+'/ok', configured=True)
        self.assertEqual(out.json(), {'ok':True})
        self.assertEqual(out.mime, 'application/json')

    async def test_streaming_declared_compressed_and_timeout_bounds(self):
        for path, maximum in [('/ok',3),('/chunked',100),('/compressed',100)]:
            with self.assertRaisesRegex(ValueError, '大小限制'):
                await request(self.url+path, configured=True, maximum=maximum)
        with self.assertRaisesRegex(ValueError, '超时'):
            await request(self.url+'/slow', configured=True, timeout=.01)

    async def test_same_origin_redirect_and_cross_origin_credential_protection(self):
        out = await request(self.url+'/same', configured=True, headers={'Authorization':'Bearer fixture-secret'})
        self.assertTrue(out.ok)
        self.assertEqual(self.hits[-1][1]['Authorization'], 'Bearer fixture-secret')
        self.hits.clear()
        with self.assertRaisesRegex(ValueError, '跨站'):
            await request(self.url+'/cross', configured=True, headers={'Authorization':'Bearer fixture-secret'})
        self.assertEqual(len(self.hits), 1)

    async def test_explicit_http_proxy_path(self):
        out = await request('http://service.invalid/ok', configured=True, proxy=self.url)
        self.assertTrue(out.ok)
        self.assertEqual(self.hits[-1][1]['Host'], 'service.invalid')


if __name__ == '__main__':
    unittest.main()
