"""Persona boundaries and recoverable multi-file mutations. No production path discovery."""
import copy
import hashlib
import math
from pathlib import Path
import re
import time
import uuid
from .memory import valid_key
from .state import read_json, write_json, write_text

FILES = {"memory.json", "memory.json.reset.json", "long-memory.json", "long-memory.json.state.json", "chat-settings.json", "custom-commands.json", "command-center.json"}


def persona_name(value):
    if not isinstance(value, str) or not value.strip() or value != value.strip() or len(value) > 60 or re.search(r'[\\/:*?"<>|\x00-\x1f]', value) or value.endswith((".", " ")) or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", value, re.I):
        raise ValueError("人格名称无效")
    return value


def persona_text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 262144 or "\0" in value:
        raise ValueError("人格正文为空或不是有效纯文本")
    return value.removeprefix("\ufeff")


def digest(text):
    return hashlib.sha256(text.strip().encode()).hexdigest()


def normalize_patch(patch):
    if not isinstance(patch, dict):
        raise ValueError("会话设置格式错误")
    out = {}
    for key in ("enabled", "atReplyEnabled", "proactiveEnabled"):
        if key in patch:
            out[key] = patch[key] is not False
    for key, low, high, integer in [("proactiveRate", 0, 1, False), ("emojiKeepRate", 0, 1, False), ("replyMaxLines", 1, 5, True), ("lineMaxChars", 10, 200, True)]:
        if key in patch:
            value = patch[key]
            if value is None or value == "":
                out[key] = None
            else:
                try:
                    value = float(value)
                    out[key] = max(low, min(high, math.floor(value) if integer else value)) if math.isfinite(value) else None
                except (ValueError, TypeError, OverflowError):
                    out[key] = None
    for key, size in [("persona", 60), ("note", 60), ("customPrompt", 4000)]:
        if key in patch:
            out[key] = str(patch[key] or "")[:size].strip() if key == "persona" else str(patch[key] or "")[:size]
    if "quietHours" in patch:
        value = str(patch["quietHours"] or "").strip()
        out["quietHours"] = None if patch["quietHours"] is None else value if not value or re.fullmatch(r"\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}", value) else None
    return out


def transaction_path(config, label):
    if label == "$env":
        return config.env_file
    if label not in FILES and not re.fullmatch(r"(?:memory|long-memory)__[a-f0-9]{64}\.json", label):
        raise ValueError("事务包含未知文件")
    path = config.data_dir / label
    if path.is_symlink() or config.data_dir.is_symlink():
        raise ValueError("记忆事务不支持符号链接")
    return path


def recover_session(config):
    file = config.data_dir / "session-transition.json"
    state = read_json(file)
    if state is None:
        return False
    if state.get("version") != 1 or state.get("phase") not in {"prepared", "committed"} or not isinstance(state.get("before"), dict):
        raise ValueError("人格事务损坏，请检查私有备份")
    if state["phase"] == "prepared":
        for label, content in state["before"].items():
            path = transaction_path(config, label)
            if content is not None and not isinstance(content, str):
                raise ValueError("事务备份内容无效")
        for label, content in state["before"].items():
            path = transaction_path(config, label)
            if content is None:
                path.unlink(missing_ok=True)
            else:
                write_text(path, content)
    file.unlink()
    return True


class Sessions:
    def __init__(self, config, memory, long_memory, settings):
        self.config, self.memory, self.long, self.settings = config, memory, long_memory, settings
        self.file = config.data_dir / "chat-settings.json"
        self.journal = config.data_dir / "session-transition.json"
        if self.journal.exists():
            raise RuntimeError("存在未完成的人格事务，请先在实例锁内恢复")

    @property
    def directory(self):
        path = Path(self.config.get("PERSONA_DIR", str(self.config.data_dir / "personas")))
        return path if path.is_absolute() else self.config.env_file.parent / path

    def path(self, name):
        path = self.directory / (persona_name(name)+".txt")
        if path.is_symlink() or self.directory.is_symlink():
            raise ValueError("人格文件不支持符号链接")
        return path

    def read(self, name):
        return persona_text(self.path(name).read_text(encoding="utf-8-sig"))

    def list(self):
        if not self.directory.exists():
            return []
        return [{"name": f.stem, "size": f.stat().st_size} for f in sorted(self.directory.glob("*.txt")) if not f.is_symlink()]

    def transaction(self, reason, mutate, extra=()):
        if self.journal.exists():
            raise RuntimeError("上次事务尚未恢复")
        recent, long, settings = self.memory.snapshot(), self.long.snapshot(), copy.deepcopy(self.settings)
        values = copy.deepcopy(self.config.values)
        before = {}
        for label in [*sorted(FILES), "$env", *extra]:
            path = transaction_path(self.config, label)
            before[label] = path.read_text(encoding="utf-8") if path.exists() else None
        state = {"version": 1, "phase": "prepared", "at": time.time()*1000, "reason": reason, "before": before}
        backup = self.config.data_dir / "config-backups" / f"session-{uuid.uuid4()}.json"
        write_json(backup, state)
        write_json(self.journal, state)
        try:
            result = mutate()
            state["phase"] = "committed"
            write_json(self.journal, state)
        except BaseException:
            recover_session(self.config)
            self.memory.chats, self.memory.boundary = recent["chats"], {k: v for k, v in recent.items() if k != "chats"}
            self.long.chats, self.long.state = long["chats"], {k: v for k, v in long.items() if k != "chats"}
            self.settings.clear(); self.settings.update(settings)
            self.config.values = values
            raise
        self.journal.unlink(missing_ok=True)
        self.config.persona_revision = getattr(self.config, "persona_revision", 0)+1
        return result

    def set(self, key, patch, remove=False):
        valid_key(key)
        patch = normalize_patch(patch)
        old = self.settings.get(key, {})
        chosen = "" if remove else patch.get("persona", old.get("persona", ""))
        chosen_digest = digest(self.read(chosen)) if chosen else ""
        changed = (old.get("persona", ""), old.get("personaDigest", "")) != (chosen, chosen_digest)
        next = {**old, **patch, "persona": chosen, "personaDigest": chosen_digest}
        def mutate():
            if changed:
                self.memory.clear(key); self.long.clear(key)
            if remove:
                self.settings.pop(key, None)
            else:
                self.settings[key] = next
            write_json(self.file, self.settings)
        if changed:
            self.transaction("切换会话人格", mutate)
        else:
            mutate()
            self.config.persona_revision = getattr(self.config, "persona_revision", 0)+1
        return {"ok": True, "settings": next if not remove else {}, "memoryReset": {"backedUp": True} if changed else None}

    def prepare(self, key):
        name = self.settings.get(key, {}).get("persona", "")
        if name and self.settings[key].get("personaDigest") != digest(self.read(name)):
            self.set(key, {"persona": name})

    def activate(self, name):
        text = self.read(name).strip()
        if self.config.environ.get("ACTIVE_PERSONA", name) != name:
            raise ValueError("ACTIVE_PERSONA被进程环境固定，请先解除环境覆盖")
        previous = self.config.get("ACTIVE_PERSONA")
        if previous == name:
            self.config.persona_revision = getattr(self.config, "persona_revision", 0)+1
            return {"ok": True, "changed": False, "persona": text}
        partition = lambda prefix, value: prefix+"__"+hashlib.sha256(value.encode()).hexdigest()+".json"
        recent_name, long_name = partition("memory", previous), partition("long-memory", previous)
        def target(prefix):
            file = self.config.data_dir / partition(prefix, name)
            legacy = self.config.data_dir / f"{prefix}__{name}.json"
            return read_json(file if file.exists() or not legacy.exists() else legacy)
        recent, long = target("memory"), target("long-memory")
        for value in (recent, long):
            if value is not None and (not isinstance(value, dict) or not isinstance(value.get("chats"), dict)):
                raise ValueError("人格记忆分区损坏，未切换")
        def mutate():
            write_json(self.config.data_dir / recent_name, self.memory.snapshot())
            write_json(self.config.data_dir / long_name, self.long.snapshot())
            self.memory.restore(recent or {"chats": {}, "resetAt": time.time()*1000, "keyResetAt": {}})
            self.long.restore(long or {"chats": {}, "epoch": str(uuid.uuid4()), "keyEpochs": {}})
            self.config.save({"ACTIVE_PERSONA": name})
            return {"ok": True, "changed": True, "persona": text, "reset": {"backedUp": True}}
        return self.transaction("切换全局人格", mutate, [recent_name, long_name])

    def save(self, name, content, create=False):
        file = self.path(name)
        content = persona_text(content)
        if create and any(item["name"].casefold() == name.casefold() for item in self.list()):
            raise ValueError("同名人格已存在")
        if file.exists() and not create:
            write_text(self.config.data_dir / "config-backups" / f"persona-{uuid.uuid4()}.txt", file.read_text(encoding="utf-8-sig"))
        write_text(file, content)
        self.config.persona_revision = getattr(self.config, "persona_revision", 0)+1
        return {"ok": True, "applied": name == self.config.get("ACTIVE_PERSONA"), "content": content}
