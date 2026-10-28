"""Target-watch queue tests with fake responders and no network access."""
import asyncio
import tempfile
import unittest
from koukou.config import Config
from koukou.messages import Message
from koukou.watch import TargetWatch


class WatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(self.temp.name, environ={"TARGET_WATCH_ENABLED": "1", "TARGET_WATCH_GROUP": "201", "TARGET_WATCH_USER": "101"})
        self.results, self.sent = [], []
        self.quiet, self.revision, self.online = False, 0, True
        async def respond(batch, can_continue):
            if can_continue():
                self.sent.append([item.text for item in batch]); return True
            return False
        self.watch = TargetWatch(self.config, current=lambda e: self.online and e.get("fresh", True),
                                 accepted_current=lambda e: self.online,
                                 respond=respond, quiet=lambda key: self.quiet,
                                 state_token=lambda key: self.revision)

    async def asyncTearDown(self):
        self.watch.stop()
        self.temp.cleanup()

    def note(self, mid=1, text="第一句话", **patch):
        event = {"message_type": "group", "group_id": 201, "user_id": 101, "message_id": mid, "time": 1800000000, **patch}
        self.watch.note(event, Message(text=text), history=[{"role": "user", "content": text}])
        return event

    async def test_target_filter_and_direct_at_avoid_duplicates(self):
        self.note(user_id=102); self.note(group_id=202); self.note(fresh=False)
        self.watch.note({"message_type": "group", "group_id": 201, "user_id": 101}, Message(text="@你", at_bot=True))
        self.assertFalse(self.watch.pending)
        self.note(); self.note()
        self.assertEqual(len(self.watch.pending), 1)
        self.watch.mark_replied(1)
        self.assertFalse(await self.watch.tick())
        self.assertFalse(self.sent)

    async def test_exact_main_reply_dedup_keeps_newer_target_messages(self):
        self.note(1, "已回复"); self.note(2, "还没回复")
        self.watch.mark_replied(1)
        self.assertTrue(await self.watch.tick())
        self.assertEqual(self.sent, [["还没回复"]])
        self.assertFalse(self.watch.pending)

    async def test_quiet_and_disconnected_windows_do_not_catch_up(self):
        self.note(); self.quiet = True
        self.assertFalse(await self.watch.tick()); self.assertFalse(self.watch.pending)
        self.quiet = False; self.note(2); self.online = False
        self.assertFalse(await self.watch.tick()); self.assertFalse(self.watch.pending)
        self.online = True
        self.assertFalse(await self.watch.tick()); self.assertFalse(self.sent)

    async def test_new_arrival_preserves_accepted_reply_and_next_window(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(batch, can_continue):
            started.set(); await release.wait()
            self.assertTrue(can_continue())
            self.sent.append([item.id for item in batch]); return True
        self.watch.respond = slow
        first = self.note(1)
        task = asyncio.create_task(self.watch.tick())
        await started.wait(); self.note(2, "后来新到")
        first["fresh"] = False  # Accepted generation ignores the passage of age.
        release.set(); await task
        self.assertEqual(self.sent, [["1"]])
        self.assertEqual([item.id for item in self.watch.pending], ["2"])

    async def test_manual_boundary_change_cancels_inflight_reply(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(batch, can_continue):
            started.set(); await release.wait()
            self.assertFalse(can_continue()); return False
        self.watch.respond = slow
        self.note()
        task = asyncio.create_task(self.watch.tick())
        await started.wait(); self.revision += 1; release.set(); await task
        self.assertFalse(self.sent); self.assertFalse(self.watch.pending)

    async def test_pending_arrival_history_is_an_independent_snapshot(self):
        event = self.note()
        event["sender"] = {"nickname": "后来修改"}
        self.assertNotIn("sender", self.watch.pending[0].event)
        self.assertEqual(self.watch.pending[0].history, [{"role": "user", "content": "第一句话"}])

    async def test_rate_gate_can_explicitly_retry_without_counting_or_sending(self):
        async def gated(batch, can_continue):
            return {"confirmed": False, "retryable": True}
        self.watch.respond = gated
        self.note()
        self.assertFalse(await self.watch.tick())
        self.assertEqual(len(self.watch.pending), 1)
        self.assertFalse(self.sent)

    async def test_unknown_delivery_and_exceptions_are_not_retried(self):
        async def unknown(batch, can_continue):
            return False
        self.watch.respond = unknown
        self.note()
        self.assertFalse(await self.watch.tick())
        self.assertFalse(self.watch.pending)
        async def failed(batch, can_continue):
            raise OSError("unknown receipt")
        self.watch.respond = failed
        self.note(2)
        self.assertFalse(await self.watch.tick())
        self.assertFalse(self.watch.pending)

    async def test_target_change_invalidates_old_inflight_batch(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(batch, can_continue):
            started.set(); await release.wait()
            self.assertFalse(can_continue()); return False
        self.watch.respond = slow
        self.note()
        task = asyncio.create_task(self.watch.tick())
        await started.wait()
        state = self.watch.configure(enabled=False, group_id="202", user_id="102")
        release.set(); await task
        self.assertEqual(state, {"enabled": False, "groupId": "202", "userId": "102"})
        self.assertFalse(self.watch.pending)

    async def test_queue_reset_invalidates_inflight_generation(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(batch, can_continue):
            started.set(); await release.wait()
            self.assertFalse(can_continue()); return False
        self.watch.respond = slow
        self.note()
        task = asyncio.create_task(self.watch.tick())
        await started.wait(); self.watch.reset_pending(); release.set()
        self.assertFalse(await task)
        self.assertFalse(self.sent)

    async def test_cancelled_unknown_delivery_does_not_replay_batch(self):
        submitted = asyncio.Event()
        async def interrupted(batch, can_continue):
            # Simulate cancellation between submitting a send and its receipt.
            submitted.set(); await asyncio.Event().wait()
        self.watch.respond = interrupted
        self.note()
        task = asyncio.create_task(self.watch.tick())
        await submitted.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(self.watch.pending)
        self.assertFalse(self.watch.busy)


if __name__ == "__main__":
    unittest.main()
