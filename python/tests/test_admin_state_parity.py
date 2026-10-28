"""Console parity checks for live port probing and chat name prefetch."""
import asyncio
import socket
import tempfile
import types
import unittest
from pathlib import Path

from koukou.admin import Admin
from koukou.config import Config
from koukou.memory import Memory, LongMemory
from koukou.plugins import PluginManager


def open_port():
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    sock.listen(1)
    return sock, sock.getsockname()[1]


class FakeOneBot:
    def __init__(self):
        self.timeline = types.SimpleNamespace(session='session-1')

    def status(self):
        return {'connected': True, 'online': True}

    async def api(self, action, params=None):
        if action == 'get_group_list':
            return [{'group_id': 200000002, 'group_name': '本地测试群', 'member_count': 7}]
        if action == 'get_friend_list':
            return [{'user_id': 200000011, 'nickname': '测试好友', 'remark': ''}]
        raise AssertionError('unexpected action ' + action)


class StateParityTests(unittest.IsolatedAsyncioTestCase):
    def admin(self, environ, onebot=None):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        config = Config(root, environ=environ)
        return Admin(config, PluginManager(root, config), Memory(config.data_dir),
                     LongMemory(config.data_dir), onebot=onebot)

    async def test_state_probes_the_onebot_port_like_the_js_console(self):
        sock, port = open_port()
        try:
            admin = self.admin({'ONEBOT_WS_URL': f'ws://127.0.0.1:{port}/ws'})
            state = await admin.state({})
            self.assertIs(state['bot']['napcatPort'], True)
            self.assertEqual(state['bot']['napcatPortNumber'], port)
        finally:
            sock.close()
        closed = socket.socket()
        closed.bind(('127.0.0.1', 0))
        closed_port = closed.getsockname()[1]
        closed.close()
        admin = self.admin({'ONEBOT_WS_URL': f'ws://127.0.0.1:{closed_port}/ws'})
        state = await admin.state({})
        self.assertIs(state['bot']['napcatPort'], False)
        self.assertEqual(state['bot']['napcatPortNumber'], closed_port)

    async def test_chats_prefetch_group_and_friend_names(self):
        admin = self.admin({'WHITELIST_GROUPS': '200000002', 'ADMIN_USERS': '200000011'}, onebot=FakeOneBot())
        self.assertEqual(admin.group_names, {})
        await admin.prefetch_names()
        items = {item['key']: item for item in admin.get_chats({})['items']}
        self.assertEqual(items['g200000002']['name'], '本地测试群')
        self.assertEqual(items['g200000002']['members'], 7)
        self.assertEqual(items['p200000011']['name'], '测试好友')


if __name__ == '__main__':
    unittest.main()
