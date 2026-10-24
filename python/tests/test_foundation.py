import asyncio
from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from koukou.config import Config, parse_env
from koukou.messages import parse_message, repeat_fingerprint, quiet_hour, Timeline
from koukou.state import InstanceLock, read_json, write_json
from koukou.memory import Memory, LongMemory
from koukou.models import ModelClient, clean_reply
from koukou.onebot import OneBot, OneBotError


class StateTests(unittest.TestCase):
    def test_env_utf8_empty_numeric_and_instance_boundaries(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / ".env"
            file.write_text('# comment\nexport PERSONA="你好"\nN=\nZERO=0\nA=旧\nA=重复\n', encoding="utf-8")
            config = Config(root, environ={"PERSONA": "环境覆盖"})
            self.assertEqual(config.persona(), "环境覆盖")
            self.assertEqual(config.number("N", 5), 5)
            self.assertEqual(config.number("ZERO", 5), 0)
            config.save({"A": "新"})
            self.assertEqual(sum(line.startswith("A=") for line in file.read_text(encoding="utf-8").splitlines()), 1)
            self.assertEqual(config.data_dir, Path(root) / "data-python")
            with self.assertRaises(ValueError):
                config.save({"A": "x\nADMIN_USERS=1"})

    def test_corrupt_files_and_cross_runtime_lock(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "broken.json"
            file.write_text("{broken", encoding="utf-8")
            with self.assertRaises(ValueError):
                read_json(file, {})
            self.assertEqual(file.read_text(encoding="utf-8"), "{broken")
            with InstanceLock(root):
                with self.assertRaises(RuntimeError):
                    InstanceLock(root).acquire()
            self.assertFalse((Path(root) / "bot.lock").exists())
            write_json(Path(root) / "bot.lock", {"pid": 123})
            with self.assertRaises(RuntimeError):
                InstanceLock(root).acquire()

    def test_memory_clear_boundary_edit_and_no_read_creation(self):
        with tempfile.TemporaryDirectory() as root:
            memory = Memory(root, 2)
            self.assertEqual(memory.get("g1"), [])
            self.assertFalse(memory.chats)
            memory.push("g1", "user", "第一条", messageId=1)
            memory.push("g1", "user", "重复投递", messageId=1)
            self.assertEqual(len(memory.get("g1")), 1)
            memory.edit("g1", 0, "手动修改")
            self.assertEqual(memory.get("g1")[0]["content"], "手动修改")
            memory.clear("g1")
            self.assertEqual(Memory(root).get("g1"), [])
            self.assertTrue(Path(root, "memory.json.reset.json").exists())
            with self.assertRaises(ValueError):
                memory.get("../secret")


class MessageTests(unittest.TestCase):
    def test_cq_and_mixed_faces_match(self):
        parsed = parse_message('你好[CQ:at,qq=42][CQ:reply,id=5][CQ:face,id=66]', 42)
        self.assertTrue(parsed.at_bot)
        self.assertEqual(parsed.reply_id, "5")
        self.assertIn("表情:66", parsed.text)
        self.assertEqual(repeat_fingerprint('你好💀[CQ:face,id=66]'), repeat_fingerprint([
            {"type": "text", "data": {"text": "你好💀"}}, {"type": "face", "data": {"id": "66"}}]))
        self.assertIsNone(repeat_fingerprint('[CQ:image,file=abc]'))
        self.assertIsNone(repeat_fingerprint('/help'))

    def test_quiet_boundaries_and_reconnect(self):
        self.assertTrue(quiet_hour("23:00-07:00", datetime(2026, 1, 1, 1)))
        self.assertFalse(quiet_hour("23:00-07:00", datetime(2026, 1, 1, 7)))
        self.assertFalse(quiet_hour("01:99-07:00"))
        timeline = Timeline(now=lambda: 1000)
        timeline.begin()
        old, live = {"time": 999}, {"time": 1000}
        timeline.receive(old); timeline.receive(live)
        self.assertFalse(timeline.current(old)); self.assertTrue(timeline.current(live))
        timeline.end(); timeline.begin()
        self.assertFalse(timeline.current(live))

    def test_flash_payload_never_downgrades_effort(self):
        model = ModelClient(None, api_key="test-only", base_url="https://example.invalid/v1", max_tokens=200)
        body = model.payload("测试", [{"role": "user", "content": "问题"}])
        self.assertEqual(body["reasoning_effort"], "max")
        self.assertNotIn("max_tokens", model.payload("", [], unlimited=True))
        self.assertEqual(clean_reply('<｜DSML｜invoke name="search">'), "")
        self.assertEqual(clean_reply("完整句子，不截断。"), "完整句子，不截断。")


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_long_memory_manual_edit_cancels_stale_task(self):
        with tempfile.TemporaryDirectory() as root:
            started, finish = asyncio.Event(), asyncio.Event()
            class Model:
                async def chat(self, *args, **kwargs):
                    started.set()
                    await finish.wait()
                    return "迟到的旧摘要"
            memory = LongMemory(root, Model())
            memory.enqueue("g1", [{"role": "user", "content": "事实原话", "time": 1}])
            task = asyncio.create_task(memory.summarize("g1"))
            await started.wait()
            memory.edit("g1", "手工更正", paused=True)
            finish.set()
            self.assertFalse(await task)
            self.assertEqual(memory.record("g1")["summary"], "手工更正")
            self.assertEqual(len(memory.record("g1")["pending"]), 1)
            self.assertTrue(list(Path(root).rglob("*.jsonl")))

    async def test_long_memory_preserves_new_arrivals(self):
        with tempfile.TemporaryDirectory() as root:
            started, finish = asyncio.Event(), asyncio.Event()
            class Model:
                async def chat(self, *args, **kwargs):
                    started.set(); await finish.wait(); return "新摘要"
            memory = LongMemory(root, Model())
            memory.enqueue("g1", [{"role": "user", "content": "旧批次"}])
            task = asyncio.create_task(memory.summarize("g1")); await started.wait()
            memory.enqueue("g1", [{"role": "user", "content": "后来一条"}])
            finish.set(); self.assertTrue(await task)
            self.assertEqual([x["text"] for x in memory.record("g1")["pending"]], ["后来一条"])

    async def test_onebot_echo_owner_timeout_and_no_retry(self):
        sent = []
        class Socket:
            closed = False
            async def send_json(self, payload):
                sent.append(payload)
        bot = OneBot("ws://example.invalid")
        socket = Socket(); bot.ws = socket
        task = asyncio.create_task(bot.api("get_status")); await asyncio.sleep(0)
        echo = sent[-1]["echo"]
        bot.receive({"echo": echo, "status": "ok", "retcode": 0, "data": {"online": True}}, Socket())
        self.assertFalse(task.done())
        bot.receive({"echo": echo, "status": "ok", "retcode": 0, "data": {"online": True}}, socket)
        self.assertTrue((await task)["online"])
        with self.assertRaises(OneBotError) as raised:
            await bot.api("send_group_msg", {"group_id": 1}, timeout=.01)
        self.assertTrue(raised.exception.outcome_unknown)
        self.assertEqual(len(sent), 2)
        self.assertFalse(bot.pending)


if __name__ == "__main__":
    unittest.main()
