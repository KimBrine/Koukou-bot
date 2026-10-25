"""OneBot message segments, freshness and quiet-hour policy."""
import hashlib
import html
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

TABLES = json.loads(Path(__file__).with_name('message_tables.json').read_text(encoding='utf-8'))


def cq_unescape(value):
    return str(value).replace("&amp;", "&").replace("&#91;", "[").replace("&#93;", "]").replace("&#44;", ",")


def segments(raw):
    if isinstance(raw, list):
        return raw
    result, end, text = [], 0, str(raw or "")
    for match in re.finditer(r"\[CQ:([a-z_]+)((?:,[^\]]*)?)\]", text):
        if match.start() > end:
            result.append({"type": "text", "data": {"text": cq_unescape(text[end:match.start()])}})
        data = {}
        for pair in match[2].lstrip(",").split(","):
            if "=" in pair:
                key, value = pair.split("=", 1)
                data[key] = cq_unescape(value)
        result.append({"type": match[1], "data": data})
        end = match.end()
    if end < len(text):
        result.append({"type": "text", "data": {"text": cq_unescape(text[end:])}})
    return result


@dataclass
class Message:
    text: str = ""
    at_bot: bool = False
    reply_id: str = ""
    images: list = field(default_factory=list)
    mentions: list = field(default_factory=list)
    forwards: list = field(default_factory=list)


def forward_segments(raw):
    result = []
    for item in segments(raw):
        if not isinstance(item, dict):
            continue
        if item.get('type') in {'forward', 'node'}:
            result.append(item)
        elif item.get('type') == 'json':
            try:
                card = item.get('data', {}).get('data')
                card = json.loads(card) if isinstance(card, str) else card
                if not isinstance(card, dict) or card.get('app') != 'com.tencent.multimsg':
                    continue
                detail = card.get('meta', {}).get('detail') or card.get('meta', {}).get('detail_1', {})
                id = detail.get('resid', detail.get('resId', detail.get('m_resid')))
                if not isinstance(id, str) or not id.strip():
                    continue
                values = [detail.get('desc'), detail.get('summary'), *[v.get('text') for v in detail.get('news', [])[:3] if isinstance(v, dict)]]
                preview = ' '.join(v[:200] for v in values if isinstance(v, str))[:600]
                result.append({'type': 'forward', 'data': {'id': id.strip(), **({'preview': preview} if preview else {})}})
            except (ValueError, TypeError, AttributeError):
                continue
    return result


def parse_message(raw, self_id="", preserve_newlines=False):
    result = Message()
    result.forwards = forward_segments(raw)
    parts = []
    for segment in segments(raw):
        if not isinstance(segment, dict):
            continue
        data, kind = segment.get("data", {}), segment.get("type")
        if not isinstance(data, dict):
            continue
        if kind == "text":
            parts.append(str(data.get("text", "")))
        elif kind == "at":
            uid = str(data.get("qq", ""))
            result.at_bot |= bool(self_id) and uid == str(self_id)
            if uid != str(self_id):
                result.mentions.append(uid)
                if uid and uid != 'all':
                    parts.append(f'[@{uid}]')
        elif kind == "reply":
            result.reply_id = str(data.get("id", ""))
        elif kind == "image":
            result.images.append(data)
            parts.append('[图片]')
        elif kind == "face":
            name = str((data.get('raw') or {}).get('faceText') or '').removeprefix('/').strip() or TABLES['faces'].get(str(data.get('id', '')).lstrip('0') or '0', '')
            parts.append(f'[表情:{name}]' if name else '[表情]')
        elif kind in {'record', 'video'}:
            parts.append('[语音]' if kind == 'record' else '[视频]')
        elif kind in {'forward', 'node'} or kind == 'json' and forward_segments([segment]):
            parts.append('[合并聊天记录]')
    text = (' ' if isinstance(raw, list) else '').join(parts)
    result.text = re.sub(r'[^\S\n]+' if preserve_newlines else r'\s+', ' ', text.replace('\r\n', '\n').replace('\r', '\n')).strip() if isinstance(raw, list) else text.strip()
    return result


def chat_key(event):
    return f"g{event['group_id']}" if event.get("group_id") else f"p{event['user_id']}"


def quiet_hour(spec, now=None):
    match = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*", spec or "")
    if not match:
        return False
    a, b, c, d = map(int, match.groups())
    if a > 23 or c > 24 or b > 59 or d > 59 or (c == 24 and d):
        return False
    start, end = a * 60 + b, c * 60 + d
    current = now or datetime.now()
    value = current.hour * 60 + current.minute
    return start <= value < end if start < end else (value >= start or value < end) if start != end else False


def repeat_fingerprint(raw):
    parts = []
    for item in segments(raw):
        kind, data = item.get("type"), item.get("data", {})
        if kind == "text":
            text = str(data.get("text", ""))
            if parts and parts[-1][0] == "text":
                parts[-1][1] += text
            elif text:
                parts.append(["text", text])
        elif kind == "face" and re.fullmatch(r"[0-9]{1,10}", str(data.get("id", ""))):
            result = data.get("resultId")
            if result is None:
                result = (data.get("raw") or {}).get("resultId")
            parts.append(["face", str(int(data["id"])), str(result) if result is not None else ""])
        else:
            return None
    if not parts or not any(p[0] == "face" or p[1].strip() for p in parts):
        return None
    text = "".join(p[1] for p in parts if p[0] == "text")
    if re.match(r"\s*[/／]", text):
        return None
    if re.fullmatch(r"\s*(?:今日总结|每日总结|群总结|群聊总结)\s*(?:d\s*)?\d{0,2}\s*[。！!~～]?\s*", text, re.I):
        return None
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


class Timeline:
    def __init__(self, now=time.time):
        self.now, self.session, self.started_at, self.available = now, 0, 0, False

    def begin(self):
        self.session += 1
        self.started_at, self.available = int(self.now()), True

    def end(self):
        self.available = False
        self.session += 1

    def receive(self, event):
        sent = float(event.get("time", 0) or 0)
        event["_timeline"] = {"session": self.session, "time": sent,
            "historical": not self.available or sent < self.started_at or self.now() - sent > 90 or sent - self.now() > 30}

    def current(self, event):
        t = event.get("_timeline", {})
        return self.available and not t.get("historical", True) and t.get("session") == self.session and self.now() - t.get("time", 0) <= 90
