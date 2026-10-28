"""Shared per-conversation send limits, charged only for confirmed delivery.

Times are seconds (the native runtime's convention); retryAfterMs is milliseconds
for compatibility with the existing public policy format. Serialize paragraph
delivery per chat at the caller, record its first receipt, then touch later ones.
"""
from collections import defaultdict, deque
import math
import time


def _round(value):
    return math.floor(value + .5)


class RateLimiter:
    def __init__(self, per_hour=25, min_gap_ms=4000, *, now=time.time):
        self.per_hour = max(0, int(per_hour))
        self.min_gap_ms = max(0, float(min_gap_ms))
        self.now = now
        self.last_sent = {}
        self.history = defaultdict(deque)

    def check(self, key, now=None, *, ignore_gap=False, per_hour_limit=None):
        stamp = self.now() if now is None else now
        gap = (stamp - self.last_sent.get(key, 0)) * 1000
        if not ignore_gap and self.min_gap_ms > 0 and key in self.last_sent and gap < self.min_gap_ms:
            return {"allowed": False, "retryable": True,
                    "retryAfterMs": self.min_gap_ms-gap,
                    "reason": f"距上次发言仅 {_round(gap/1000)}s（下限 {_round(self.min_gap_ms/1000)}s）"}
        cap = self.per_hour if per_hour_limit is None else per_hour_limit
        recent = self.history.get(key, ())
        count = sum(stamp - value < 3600 for value in recent)
        if cap > 0 and count >= cap:
            return {"allowed": False, "retryable": False,
                    "reason": f"本会话一小时内已发言 {count} 次（上限 {cap:g}）"}
        return {"allowed": True}

    def record(self, key, now=None):
        """Count the first successfully sent message in one whole reply."""
        stamp = self.now() if now is None else now
        self.last_sent[key] = stamp
        recent = self.history[key]
        recent.append(stamp)
        while recent and stamp-recent[0] >= 3600:
            recent.popleft()

    def touch(self, key, now=None):
        """Update spacing after another confirmed line; consume no new quota."""
        self.last_sent[key] = self.now() if now is None else now

    @classmethod
    def from_config(cls, config, **kwargs):
        return cls(config.number("RATE_LIMIT_PER_HOUR", 25),
                   config.number("RATE_LIMIT_MIN_GAP_MS", 4000), **kwargs)
