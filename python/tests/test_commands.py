import asyncio
from pathlib import Path
import tempfile
import unittest
from koukou.commands import CommandRegistry
from koukou.plugins import PluginManager
from koukou.state import write_json
import test_native_bot as fixtures


class UnifiedCommandsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixtures.BotTests.asyncSetUp(self)
        self.plugins = PluginManager(self.temp.name, self.config)
        self.plugins.create("hello", "打招呼")
        self.registry = CommandRegistry(self.config, self.plugins)
        self.bot.plugins, self.bot.commands = self.plugins, self.registry

    event = fixtures.BotTests.event

    async def asyncTearDown(self):
        await fixtures.BotTests.asyncTearDown(self)

    async def test_direct_slash_chinese_alias_fullwidth_and_legacy(self):
        await self.bot.handle(self.event('/hello "中文 参数"', id=11, private=True))
        self.assertEqual(self.output[-1], "收到：中文 参数")
        self.plugins.set_command("hello", "问候")
        await self.bot.handle(self.event('／问候 第二次', id=12, private=True))
        self.assertEqual(self.output[-1], "收到：第二次")
        await self.bot.handle(self.event('/py hello 旧入口', id=13, private=True))
        self.assertEqual(self.output[-1], "收到：旧入口")
        entry = self.registry.plugin_entries()[0]
        self.assertEqual(entry["trigger"], "/问候 [参数]")
        self.assertTrue(entry["usage"].startswith("/问候"))

    async def test_group_requires_direct_address_and_help_flattens_plugins(self):
        calls, original = [], self.plugins.run
        async def run(*args, **kwargs):
            calls.append(args)
            return await original(*args, **kwargs)
        self.plugins.run = run
        await self.bot.handle(self.event('/hello 没有艾特', id=21))
        self.assertFalse(calls)
        event = self.event('/hello 有艾特', id=22)
        event["message"].insert(0, {"type": "at", "data": {"qq": self.bot.onebot.self_id}})
        await self.bot.handle(event)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.output[-1], "收到：有艾特")
        await self.bot.handle(self.event('/help', id=23, private=True))
        self.assertIn('/hello [参数]', self.output[-1])
        self.assertNotIn('/py', self.output[-1])
        self.assertIn('/Q', self.output[-1])

    async def test_default_permissions_stay_admin_only_and_scope_applies(self):
        event = self.event('/hello', id=31, private=True)
        event["user_id"] = 200000099
        self.config.values["PRIVATE_WHITELIST"] += ',200000099'
        await self.bot.handle(event)
        self.assertFalse(self.output)
        self.registry.save_plugin({"id": "plugin:hello", "adminOnly": False, "scope": "private"})
        event["message_id"] = 32
        await self.bot.handle(event)
        self.assertIn('你好', self.output[-1])
        self.assertNotIn('/hello', self.registry.help({"group_id": 200000002, "user_id": 200000011}))

    async def test_disable_while_plugin_running_suppresses_late_output(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def run(*_):
            started.set(); await release.wait(); return {"ok": True, "stdout": "迟到结果"}
        self.plugins.run = run
        task = asyncio.create_task(self.bot.handle(self.event('/hello', id=41, private=True)))
        await started.wait()
        self.registry.save_plugin({"id": "plugin:hello", "enabled": False})
        release.set(); await task
        self.assertFalse(self.output)
        self.assertFalse(self.plugins.enabled("hello"))

    async def test_namespace_collisions_and_protected_metadata(self):
        for name in ['help', 'Q', 'py', '群总结']:
            with self.assertRaises(ValueError):
                self.plugins.set_command("hello", name)
        self.plugins.create("other")
        with self.assertRaises(ValueError):
            self.plugins.set_command("other", "HELLO")
        write_json(self.config.data_dir / 'custom-commands.json', [{"id": "c1", "trigger": "/自定义"}])
        with self.assertRaises(ValueError):
            self.plugins.set_command("hello", "自定义")
        self.plugins.import_script('secure.py', '# admin: true\nprint("管理员功能")')
        item = self.registry.save_plugin({"id": "plugin:secure", "adminOnly": False})
        self.assertTrue(item["adminOnly"])
        with self.assertRaises(ValueError):
            self.plugins.create('help')


if __name__ == '__main__':
    unittest.main()
