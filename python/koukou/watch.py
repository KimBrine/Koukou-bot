"""Target-watch queue with immutable arrival context and exact reply deduplication.

The injected responder owns prompt/model work and the bot's shared delivery path.
It receives (batch, can_continue), returns True only after confirmed delivery,
and must check can_continue immediately before each actual send. This queue never
consumes cooldown/quota itself. No QQ/model/paid calls are made by this module.
Only {"retryable": True, "confirmed": False} preserves a window for retry: use
that solely when no send was attempted, for example when a rate gate was closed.
"""
import asyncio
from collections import deque
import copy
from dataclasses import dataclass
import time


@dataclass(frozen=True)
class WatchMessage:
    id: str
    time: float
    text: str
    event: dict
    history: list


class TargetWatch:
    def __init__(self, config, *, current, respond, accepted_current=None, quiet=None,
                 state_token=None, now=time.time, sleep=asyncio.sleep, on_error=None):
        self.config, self.current, self.respond = config, current, respond
        self.accepted_current = accepted_current or current
        self.quiet = quiet or (lambda key: False)
        self.state_token = state_token or (lambda key: None)
        self.now, self.sleep, self.on_error = now, sleep, on_error
        self.pending = []
        self.replied_ids, self.replied_order = set(), deque()
        self.busy, self.revision, self.task = False, 0, None

    @property
    def group_id(self):
        return str(self.config.get("TARGET_WATCH_GROUP", "")).strip()

    @property
    def user_id(self):
        return str(self.config.get("TARGET_WATCH_USER", "")).strip()

    @property
    def enabled(self):
        return bool(self.config.enabled("TARGET_WATCH_ENABLED", False) and self.group_id and self.user_id)

    def state(self):
        return {"enabled": self.enabled, "groupId": self.group_id, "userId": self.user_id}

    def mark_replied(self, message_id):
        if message_id is None:
            return
        mid = str(message_id)
        if mid not in self.replied_ids:
            self.replied_ids.add(mid)
            self.replied_order.append(mid)
        while len(self.replied_order) > 200:
            self.replied_ids.discard(self.replied_order.popleft())

    def note(self, event, parsed, *, history=None):
        if (not self.enabled or not self.current(event) or event.get("message_type") != "group" or
                str(event.get("group_id")) != self.group_id or str(event.get("user_id")) != self.user_id):
            return False
        at_bot = parsed.get("atBot", parsed.get("at_bot", False)) if isinstance(parsed, dict) else parsed.at_bot
        text = parsed.get("text", "") if isinstance(parsed, dict) else parsed.text
        if at_bot or not text:
            return False
        mid = str(event.get("message_id") or "")
        if mid and (mid in self.replied_ids or any(item.id == mid for item in self.pending)):
            return False
        self.pending.append(WatchMessage(mid, float(event.get("time") or self.now()), str(text)[:200],
                                         copy.deepcopy(event), copy.deepcopy(history or [])))
        return True

    def _remove(self, batch):
        # Remove by object identity, so arrivals during a model await are retained.
        identities = {id(item) for item in batch}
        self.pending[:] = [item for item in self.pending if id(item) not in identities]

    async def tick(self):
        if not self.enabled or self.busy:
            return False
        self.pending[:] = [item for item in self.pending if self.current(item.event) and item.id not in self.replied_ids]
        if not self.pending:
            return False
        key = "g"+self.group_id
        if self.quiet(key):
            self.reset_pending()
            return False
        self.busy = True
        revision, group_id, user_id = self.revision, self.group_id, self.user_id
        token = copy.deepcopy(self.state_token(key))
        batch = tuple(self.pending)
        latest = batch[-1]

        def can_continue():
            # New arrivals deliberately are not a cancellation condition.
            return (self.enabled and revision == self.revision and group_id == self.group_id and
                    user_id == self.user_id and token == self.state_token(key) and not self.quiet(key) and
                    self.accepted_current(latest.event) and latest.id not in self.replied_ids)

        try:
            if not can_continue():
                self._remove(batch)
                return False
            result = await self.respond(batch, can_continue)
            confirmed = bool(result.get("confirmed")) if isinstance(result, dict) else result is True
            retryable = isinstance(result, dict) and result.get("retryable") is True and not confirmed
            # Unknown delivery outcomes are never automatically repeated. A gate
            # may explicitly retain a window only before any send was attempted.
            if not retryable or not can_continue():
                self._remove(batch)
            if confirmed:
                for item in batch:
                    self.mark_replied(item.id)
            return confirmed
        except asyncio.CancelledError:
            # Cancellation can arrive after the responder submitted an external
            # send but before its receipt. Do not replay that ambiguous batch.
            self._remove(batch)
            raise
        except Exception as exc:
            # The callback may have failed after an external send. Avoid automatic
            # duplicate messages when no trustworthy delivery result came back.
            self._remove(batch)
            if self.on_error:
                self.on_error(exc)
            return False
        finally:
            self.busy = False

    def reset_pending(self):
        # A reset also invalidates a generation already awaiting a model. Merely
        # clearing the queue would allow it to send after quiet/persona changes.
        self.revision += 1
        self.pending.clear()
        self.replied_ids.clear()
        self.replied_order.clear()

    async def _loop(self):
        try:
            while self.enabled:
                interval = max(5000, min(600000, self.config.number("TARGET_WATCH_INTERVAL_MS", 15000)))
                await self.sleep(interval/1000)
                await self.tick()
        except asyncio.CancelledError:
            pass
        finally:
            if self.task is asyncio.current_task():
                self.task = None

    def start(self):
        if self.enabled and (self.task is None or self.task.done()):
            self.task = asyncio.create_task(self._loop())
        return self.task

    def stop(self):
        self.revision += 1
        if self.task is not None:
            self.task.cancel()
        self.task = None

    def configure(self, *, enabled=None, group_id=None, user_id=None):
        """Change runtime values only; persisted config remains caller-owned."""
        self.stop()
        patch = {}
        if enabled is not None:
            patch["TARGET_WATCH_ENABLED"] = "1" if enabled else "0"
        if group_id is not None:
            patch["TARGET_WATCH_GROUP"] = str(group_id or "")
        if user_id is not None:
            patch["TARGET_WATCH_USER"] = str(user_id or "")
        self.config.values.update(patch)
        self.reset_pending()
        self.start()
        return self.state()
