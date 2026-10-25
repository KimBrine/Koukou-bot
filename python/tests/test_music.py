import json
import unittest
from koukou.music import parse_music_request, resolve_music_request, search_song
from koukou.bot import Bot
from koukou.plugins import PluginManager
import test_native_bot as fixtures


class MusicTests(unittest.IsolatedAsyncioTestCase):
    async def test_artist_filter_avoids_wrong_cover_and_id_is_verified(self):
        async def search(url, body=None):
            return {'result': {'songs': [{'id': 1, 'name': '浮光', 'artists': [{'name': '其他歌手'}]}, {'id': 2, 'name': '浮光', 'artists': [{'name': '周深'}]}]}}
        song = await search_song(parse_music_request('点歌 浮光 周深'), search)
        self.assertEqual(song['id'], '2')
        async def wrong_id(url, body=None): return {'songs': [{'id': 3, 'name': '错误歌曲', 'artists': []}]}
        self.assertIsNone(await search_song(parse_music_request('点歌 123'), wrong_id))

    async def test_qq_mid_lookup_checks_response_identity(self):
        calls = []
        async def detail(url, body=None):
            calls.append((url, body))
            return {'req': {'data': {'track_info': {'id': 123, 'mid': '003AAAAAAA', 'name': '歌曲', 'singer': [{'name': '歌手'}]}}}}
        song = await search_song(parse_music_request('点歌 QQ音乐 mid 003AAAAAAA'), detail)
        self.assertEqual(song['id'], '123')
        self.assertEqual(calls[0][1]['req']['param'], {'song_mid': '003AAAAAAA'})

    async def test_model_cannot_invent_song_or_artist(self):
        class Model:
            async def chat(self, *args, **kwargs): return json.dumps({'title': '不存在的歌名', 'artist': '凭空编造'})
        result = await resolve_music_request('点歌 Never Gonna Give You Up', model=Model())
        self.assertIn('error', result)


class MusicBotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixtures.BotTests.asyncSetUp(self)
        protocol = self.bot.onebot
        async def send(key, text, **kwargs): self.output.append(text); return {'message_id': len(self.output)}
        protocol.send = send
        async def search(request):
            self.assertEqual(request['id'], '123')
            return {'platform': '163', 'id': '123', 'name': '歌曲', 'artist': '歌手'}
        self.plugins = PluginManager(self.temp.name, self.config)
        self.bot = Bot(self.config, protocol, self.memory, plugins=self.plugins, music_search=search)

    event = fixtures.BotTests.event
    asyncTearDown = fixtures.BotTests.asyncTearDown

    async def test_card_receipt_precedes_success_reply(self):
        await self.bot.handle(self.event('点歌 123', private=True))
        self.assertEqual(self.output[0], [{'type': 'music', 'data': {'type': '163', 'id': '123'}}])
        self.assertIn('音乐名片', self.output[1])

    async def test_unknown_card_receipt_does_not_claim_success(self):
        async def send(key, text, **kwargs):
            self.output.append(text)
            return {} if isinstance(text, list) else {'message_id': 1}
        self.bot.onebot.send = send
        await self.bot.handle(self.event('点歌 123', private=True))
        self.assertIn('未确认', self.output[-1])
        self.assertEqual(len(self.memory.get('p200000011')), 1)

    async def test_policy_change_while_searching_stops_send(self):
        async def search(request):
            self.bot.commands.save_builtin({'id': 'music', 'enabled': False})
            return {'platform': '163', 'id': '123', 'name': '歌曲', 'artist': '歌手'}
        self.bot.music_search = search
        await self.bot.handle(self.event('点歌 123', private=True))
        self.assertFalse(self.output)


if __name__ == '__main__': unittest.main()
