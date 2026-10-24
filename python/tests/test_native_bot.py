import asyncio
from pathlib import Path
import tempfile
import time
import unittest
from koukou.bot import Bot
from koukou.config import Config
from koukou.memory import Memory
from koukou.messages import Timeline


class BotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(self.temp.name, environ={"WHITELIST_GROUPS": "200000002", "PRIVATE_WHITELIST": "200000011", "ADMIN_USERS": "200000011", "PROACTIVE_RATE": "1", "PROACTIVE_COOLDOWN_MS": "0"})
        self.memory = Memory(self.config.data_dir)
        self.output, self.calls = [], []
        self.timeline = Timeline(); self.timeline.begin()
        outer = self
        class Protocol:
            self_id = "200000010"
            timeline = outer.timeline
            async def send(self, key, text):
                outer.output.append(text)
                return {"message_id": len(outer.output)}
            async def api(self, action, params):
                outer.calls.append((action, params))
                return {"message_id": 9}
        class Model:
            async def chat(self, *args, **kwargs):
                return "这是一段完整回答，不能因为字数目标而被截断。"
        self.bot = Bot(self.config, Protocol(), self.memory, model=Model(), rand=lambda: 0)

    async def asyncTearDown(self):
        self.temp.cleanup()

    def event(self, text="你好", id=1, private=False):
        value = {"post_type": "message", "message_type": "private" if private else "group", "user_id": 200000011,
                 "time": time.time(), "message_id": id, "message": [{"type": "text", "data": {"text": text}}]}
        if not private:
            value["group_id"] = 200000002
        self.timeline.receive(value)
        return value

    async def test_complete_reply_and_duplicate_event(self):
        event = self.event()
        await self.bot.handle(event); await self.bot.handle(event)
        self.assertEqual(len(self.output), 1)
        self.assertTrue(self.output[0].endswith("被截断。"))
        self.assertEqual(len(self.memory.get("g200000002")), 2)

    async def test_quiet_records_without_replies_or_plus_one(self):
        self.config.values.update(QUIET_HOURS="00:00-24:00", AUTO_PLUS_ONE_ENABLED="1")
        await self.bot.handle(self.event(id=1)); await self.bot.handle(self.event(id=2))
        self.assertEqual(len(self.memory.get("g200000002")), 2)
        self.assertFalse(self.output); self.assertFalse(self.calls)

    async def test_stale_generated_reply_and_unknown_private_are_not_sent(self):
        started, release = asyncio.Event(), asyncio.Event()
        class Slow:
            async def chat(self, *args, **kwargs):
                started.set(); await release.wait(); return "迟到回复"
        self.bot.model = Slow()
        task = asyncio.create_task(self.bot.handle(self.event()))
        await started.wait(); self.config.values["QUIET_HOURS"] = "00:00-24:00"; release.set()
        await task; self.assertFalse(self.output)
        self.config.values["QUIET_HOURS"] = ""
        event = self.event(private=True); event["user_id"] = 200000099
        await self.bot.handle(event); self.assertFalse(self.output)

    async def test_successful_paragraph_cooldown_only_after_confirmed_send(self):
        self.bot.onebot.send = self.unconfirmed
        await self.bot.handle(self.event())
        self.assertFalse(self.bot.last_proactive)
        self.assertEqual(len(self.memory.get("g200000002")), 1)

    async def test_plus_one_independent_of_ordinary_mute_and_own_echo(self):
        self.config.values.update(AUTO_PLUS_ONE_ENABLED="1", MUTED_GROUPS="200000002")
        await self.bot.handle(self.event(id=1)); await self.bot.handle(self.event(id=2))
        self.assertEqual(len(self.calls), 1)
        own = self.event(id=3); own["user_id"] = 200000010; own["post_type"] = "message_sent"
        await self.bot.handle(own)
        await self.bot.handle(self.event(id=4)); await self.bot.handle(self.event(id=5))
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.output)

    async def unconfirmed(self, *_):
        return {}


if __name__ == "__main__":
    unittest.main()
