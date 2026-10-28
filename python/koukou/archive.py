"""Append-only JS-compatible originals, with bounded retrieval per persona epoch."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def stamp(value):
    return hashlib.sha256(json_text(value).encode("utf-8")).hexdigest()


class MemoryArchive:
    def __init__(self, root):
        self.root = Path(root)

    def path(self, epoch, key):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", epoch) or not re.fullmatch(r"[gp]\d{1,24}", key):
            raise ValueError("原文分区无效")
        return self.root / epoch / (hashlib.sha256(key.encode()).hexdigest() + ".jsonl")

    def entries(self, epoch, key):
        file = self.path(epoch, key)
        if not file.exists():
            return []
        with file.open("rb") as stream:
            start = max(0, file.stat().st_size - 4*1024*1024)
            stream.seek(start)
            if start:
                stream.readline()
            lines = stream.read().decode("utf-8", errors="replace").splitlines()
        items = []
        for line in lines:
            try:
                item = json.loads(line)
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    items.append(item)
            except ValueError:
                continue
        return items[-3000:]

    def add(self, epoch, key, entries):
        known = {e.get("id") for e in self.entries(epoch, key)}
        batch = []
        for entry in entries:
            text = str(entry.get("content", entry.get("text", ""))).strip()
            if not text:
                continue
            role, at = entry.get("role", "user"), entry.get("time", 0)
            id = stamp([role, entry.get("messageId") or "", at, text])
            if id in known:
                continue
            known.add(id)
            batch.append({"id": id, "role": role, "text": text, "time": at,
                          "name": entry.get("senderName", entry.get("name", "")), "userId": entry.get("userId", "")})
        if batch:
            file = self.path(epoch, key)
            file.parent.mkdir(parents=True, exist_ok=True)
            with file.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write("".join(json_text(item)+"\n" for item in batch))
                stream.flush()
                import os
                os.fsync(stream.fileno())

    def retrieve(self, epoch, key, query, max_chars=1400):
        normalize = lambda text: "".join(c for c in text.lower() if c.isalnum())
        query = normalize(str(query)[:500])
        if len(query) < 3:
            return ""
        grams = {query[i:i+2] for i in range(len(query)-1)}
        hits = [(sum(g in normalize(e["text"]) for g in grams), e) for e in self.entries(epoch, key) if e.get("role") == "user"]
        hits = sorted((h for h in hits if h[0] >= 2), key=lambda h: (h[0], h[1].get("time", 0)), reverse=True)[:4]
        lines = []
        for _, entry in hits:
            at = datetime.fromtimestamp(entry["time"]/1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if entry.get("time") else "旧记录"
            line = f"[{at}{' '+entry['name'] if entry.get('name') else ''}] {entry['text']}"
            if len(line) <= max_chars:
                lines.append(line); max_chars -= len(line)+1
        return "\n".join(lines)
