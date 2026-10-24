import asyncio
from pathlib import Path
import tempfile
import unittest
from aiohttp.test_utils import TestClient, TestServer
from koukou.admin import Admin
from koukou.config import Config
from koukou.plugins import PluginManager, decode_result
from koukou.memory import Memory, LongMemory
from koukou.__main__ import main


class PluginTests(unittest.IsolatedAsyncioTestCase):
    async def test_template_creation_utf8_output_and_windows_path_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = PluginManager(directory)
            item = manager.create("hello", "中文模板")
            self.assertEqual(item["description"], "中文模板")
            result = await manager.run("hello", ["中文", r"C:\my folder\测试"])
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["stdout"], "收到：中文 C:\\my folder\\测试")
            with self.assertRaises(FileExistsError):
                manager.create("hello")
            manager.set_enabled("hello", False)
            with self.assertRaises(ValueError):
                await manager.run("hello")

    async def test_invalid_code_does_not_replace_plugin_and_no_path_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = PluginManager(directory)
            manager.create("hello")
            before = manager.path("hello").read_text(encoding="utf-8")
            with self.assertRaises(SyntaxError):
                manager.import_script("hello.py", "def broken(", overwrite=True)
            self.assertEqual(manager.path("hello").read_text(encoding="utf-8"), before)
            for name in ["../bad", "x/y", "x\\y", ".", "C:bad"]:
                with self.assertRaises(ValueError):
                    manager.path(name)

    async def test_structured_sdk_and_legacy_prefixes(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = PluginManager(directory)
            manager.import_script("card.py", "from koukou.plugin import plugin,Result\n@plugin.command\ndef run(args):\n return Result(text='完成',images=['file:///x.png'])\nif __name__=='__main__': plugin.run()\n")
            value = decode_result(await manager.run("card"))
            self.assertEqual(value["text"], "完成")
            self.assertEqual(value["images"], ["file:///x.png"])
            self.assertIn("legacyFile", decode_result({"ok": True, "stdout": '@@FILE@@{"path":"test.zip"}'}))
            self.assertIn("legacyCard", decode_result({"ok": True, "stdout": '@@CARD@@{"nodes":[]}'}))

    async def test_timeout_and_output_limits_do_not_hang(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = PluginManager(directory)
            manager.import_script("slow.py", "import time\ntime.sleep(60)\n")
            self.assertTrue((await manager.run("slow", timeout=.15))["killed"])
            manager.import_script("loud.py", "print('x'*1100000)\n")
            self.assertTrue((await manager.run("loud"))["killed"])
            manager.import_script("endless.py", "while True: print('x'*8192,flush=True)\n")
            self.assertTrue((await asyncio.wait_for(manager.run("endless"), 5))["killed"])


class AdminTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # Point assets at the actual repo while keeping all data/config writes isolated.
        self.root = Path(__file__).resolve().parents[2]
        self.config = Config(self.root, Path(self.temp.name) / ".env", environ={"BOT_DATA_DIR": self.temp.name})
        self.plugins = PluginManager(self.temp.name)
        self.admin = Admin(self.config, self.plugins, Memory(self.temp.name), LongMemory(self.temp.name))
        self.client = TestClient(TestServer(self.admin.app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    async def post(self, name, data, **headers):
        return await self.client.post("/api/action/" + name, json=data, headers={"X-Admin-Token": self.admin.token, **headers})

    async def test_host_auth_csrf_and_content_type(self):
        self.assertEqual((await self.client.get("/api/state", headers={"Host": "evil.invalid"})).status, 403)
        self.assertEqual((await self.client.post("/api/action/python-new-script", json={})).status, 401)
        self.assertEqual((await self.post("python-new-script", {}, Origin="https://evil.invalid")).status, 403)
        result = await self.client.post("/api/action/python-new-script", data="{}", headers={"X-Admin-Token": self.admin.token})
        self.assertEqual(result.status, 415)

    async def test_native_plugin_crud_and_secret_redaction(self):
        self.config.values["DEEPSEEK_API_KEY"] = "TEST-SECRET-NOT-A-REAL-KEY"
        response = await self.client.get("/api/config")
        self.assertNotIn("TEST-SECRET-NOT-A-REAL-KEY", await response.text())
        result = await self.post("python-new-script", {"name": "native", "description": "中文插件"})
        self.assertEqual(result.status, 200)
        listing = await (await self.client.get("/api/python-scripts")).json()
        self.assertEqual(listing["items"][0]["id"], "native")
        result = await self.post("read-python-script", {"id": "native"})
        self.assertIn("@plugin.command", (await result.json())["content"])
        result = await self.post("set-python-command", {"id": "native", "command": "中文"})
        self.assertEqual(result.status, 200)
        self.assertEqual(self.plugins.resolve("中文"), "native")

    async def test_pending_actions_fail_explicitly_and_migration_blocks_qq(self):
        response = await self.post("summary", {"groupId": 200000002})
        self.assertEqual(response.status, 501)
        self.assertFalse((await (await self.client.get("/api/migration")).json())["ready"])
        self.assertEqual(main(["--root", str(self.root), "--env-file", str(self.config.env_file), "run"]), 2)

    async def test_frontend_preserved_and_preview_identifies_migration(self):
        html = await (await self.client.get("/")).text()
        self.assertIn("Python迁移预览", html)
        self.assertIn("window.__ADMIN_TOKEN__", html)
        self.assertEqual((await self.client.get("/app.js")).status, 200)


if __name__ == "__main__":
    unittest.main()
