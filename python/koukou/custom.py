"""Editable fixed/random/AI rules, sharing literal matching and permission checks."""
import copy
from datetime import datetime, timedelta
import json
import random
import re
import time
import uuid
from .state import read_json, write_json


def scope_allows(command, context):
    scope = command.get("scope", "all")
    if scope not in {"all", "group", "groups", "private"}:
        return False
    if context.get("isPrivate"):
        return scope not in {"group", "groups"}
    return scope != "private" and (scope != "group" or int(context.get("groupId", 0)) in command.get("groups", []))


def render_reply(template, context):
    now = datetime.fromtimestamp(context.get("now", time.time()*1000)/1000)
    fields = {"name": str(context.get("name") or "").strip() or "你", "qq": str(context.get("userId", "")),
              "group": str(context.get("groupName", "")), "time": f"{now.year}/{now.month}/{now.day} {now:%H:%M:%S}",
              "date": now.strftime("%Y-%m-%d"), "args": str(context.get("args", ""))}
    return re.sub(r"\{(name|qq|group|time|date|args)\}", lambda m: fields[m[1]], str(template))


def clean(input):
    if not isinstance(input, dict):
        raise ValueError("指令格式错误")
    mode, event = input.get("responseMode", "fixed"), input.get("event", "message")
    if mode not in {"fixed", "random", "ai"} or event not in {"message", "poke"}:
        raise ValueError("不支持的回复方式或事件")
    if input.get("scheduleEnabled") and (mode != "fixed" or event != "message"):
        raise ValueError("定时推送只支持消息固定回复")
    sequence = lambda value, pattern=",": value if isinstance(value, list) else re.split(pattern, str(value or ""))
    ids = lambda value: list(dict.fromkeys(int(str(v).strip()) for v in sequence(value) if str(v).strip().isdecimal() and int(str(v).strip()) > 0))
    texts = lambda value: [str(v).strip()[:100] for v in sequence(value, r"[\n,，]") if str(v).strip()][:20]
    times = []
    for value in sequence(input.get("scheduleTimes")):
        if re.fullmatch(r"(?:[01]?\d|2[0-3]):[0-5]\d", str(value).strip()):
            h, m = str(value).strip().split(":")
            times.append(f"{int(h):02}:{int(m):02}")
    try:
        cooldown = min(86400, max(0, float(input.get("cooldownSec") or 0)))
    except (ValueError, TypeError):
        cooldown = 0
    command = {"id": str(input.get("id") or uuid.uuid4().hex[:8]), "name": str(input.get("name") or "未命名指令").strip()[:40],
               "trigger": str(input.get("trigger") or "").strip()[:100], "aliases": texts(input.get("aliases")),
               "event": event, "responseMode": mode, "aiPrompt": str(input.get("aiPrompt") or "").strip()[:4000],
               "description": str(input.get("description") or "").strip()[:800], "naturalLanguage": mode == "ai" and input.get("naturalLanguage") is True,
               "adminOnly": input.get("adminOnly") is True, "match": input.get("match") if input.get("match") in {"exact", "prefix", "contains"} else "exact",
               "reply": str(input.get("reply") or "")[:4000], "enabled": input.get("enabled") is not False,
               "scope": input.get("scope") if input.get("scope") in {"all", "group", "groups", "private"} else "all", "groups": ids(input.get("groups")),
               "cooldownSec": cooldown, "scheduleEnabled": input.get("scheduleEnabled") is True,
               "scheduleTimes": times[:10], "scheduleGroups": ids(input.get("scheduleGroups"))[:20]}
    if event != "poke" and not command["trigger"]:
        raise ValueError("触发词不能为空")
    if not (command["aiPrompt"] if mode == "ai" else command["reply"].strip()):
        raise ValueError("请填写回复内容或AI执行要求")
    if command["enabled"] and command["scope"] == "group" and not command["groups"]:
        raise ValueError("请指定适用群聊")
    return command


class CustomCommands:
    def __init__(self, file, now=time.time):
        self.file, self.now, self.last = file, now, {}
        self.all()  # Invalid state must not be silently overwritten by a later save.

    def all(self):
        items = read_json(self.file, [])
        if not isinstance(items, list) or len(items) > 200:
            raise ValueError("自定义指令库格式错误")
        return [clean(item) for item in items]

    def replace(self, items):
        if not isinstance(items, list) or len(items) > 200:
            raise ValueError("最多200条自定义指令")
        next = [clean(item) for item in items]
        if len({c["id"] for c in next}) != len(next):
            raise ValueError("指令标识重复")
        write_json(self.file, next)
        self.last.clear()

    def upsert(self, input):
        command, items = clean(input), self.all()
        index = next((i for i, item in enumerate(items) if item["id"] == command["id"]), None)
        if index is None:
            items.append(command)
        else:
            items[index] = command
        self.replace(items)
        return command

    def remove(self, id):
        items = self.all()
        self.replace([c for c in items if c["id"] != id])

    def literal(self, text, context):
        text = text.strip()
        matches = []
        for command in self.all():
            if command["event"] != context.get("event", "message"):
                continue
            triggers = [command["trigger"], *command["aliases"]]
            if command["event"] == "poke" or any(k and (text.startswith(k) if command["match"] == "prefix" else k in text if command["match"] == "contains" else text == k) for k in triggers):
                matches.append(command)
        return next((c for c in matches if c["enabled"] and scope_allows(c, context)), next((c for c in matches if scope_allows(c, context)), matches[0] if matches else None))

    def can_claim(self, command, key):
        return self.now()-self.last.get((command["id"], key), -float("inf")) >= command["cooldownSec"]

    def claim(self, command, key):
        self.last[command["id"], key] = self.now()

    def due(self, at=None, window=300):
        at = self.now() if at is None else at
        today = datetime.fromtimestamp(at)
        due = {}
        for command in self.all():
            if not command["enabled"] or not command["scheduleEnabled"] or command["responseMode"] != "fixed":
                continue
            for offset in [-1, 0]:
                for time in command["scheduleTimes"]:
                    h, m = map(int, time.split(":"))
                    date = (today+timedelta(days=offset)).replace(hour=h, minute=m, second=0, microsecond=0)
                    if not 0 <= at-date.timestamp() < window:
                        continue
                    for group in command["scheduleGroups"]:
                        if scope_allows(command, {"groupId": group}):
                            slot = json.dumps([command["id"], group, date.strftime("%Y-%m-%d"), time], ensure_ascii=False, separators=(",", ":"))
                            due[slot] = {"command": command, "groupId": group, "targetAt": date.timestamp()*1000, "slotKey": slot}
        return sorted(due.values(), key=lambda c: c["targetAt"])
