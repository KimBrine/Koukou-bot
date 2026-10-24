"""Atomic UTF-8 state. Corrupt files fail closed instead of being overwritten."""
import copy
import json
import os
from pathlib import Path
import uuid


def write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return copy.deepcopy(default)
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (ValueError, UnicodeError) as exc:
        raise ValueError(f"状态文件损坏，停止写入，请恢复备份：{path}") from exc


def write_json(path, value):
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


class InstanceLock:
    """Shares the JS bot.lock boundary; existing locks are never automatically evicted."""
    def __init__(self, directory):
        self.path = Path(directory) / "bot.lock"
        self.token, self.owned = uuid.uuid4().hex, False

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with self.path.open("x", encoding="utf-8") as stream:
                json.dump({"pid": os.getpid(), "runtime": "python", "token": self.token}, stream)
        except FileExistsError as exc:
            raise RuntimeError("数据目录已有bot.lock，拒绝同时运行两个实例") from exc
        self.owned = True
        return self

    def close(self):
        if self.owned:
            if read_json(self.path, {}).get("token") == self.token:
                self.path.unlink(missing_ok=True)
            self.owned = False

    __enter__ = acquire

    def __exit__(self, *_):
        self.close()
