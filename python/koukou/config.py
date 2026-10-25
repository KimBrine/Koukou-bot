"""Explicit, instance-local configuration with JS-compatible .env syntax."""
import os
from pathlib import Path
import re
from math import isfinite
from .state import write_text


def parse_env(text):
    result = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.removeprefix("export ").strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            result[key] = value
    return result


class Config:
    def __init__(self, root, env_file=None, environ=None):
        self.root = Path(root).resolve()
        self.environ = dict(os.environ if environ is None else environ)
        self.env_file = Path(env_file or self.environ.get("BOT_ENV_FILE") or self.root / ".env").resolve()
        self.values = parse_env(self.env_file.read_text(encoding="utf-8-sig")) if self.env_file.exists() else {}
        self.values.update(self.environ)
        self.data_dir = Path(self.get("BOT_DATA_DIR", str(self.root / "data-python"))).resolve()
        self.log_dir = Path(self.get("BOT_LOG_DIR", str(self.root / "logs-python"))).resolve()

    def get(self, name, default=""):
        return self.values.get(name, default)

    def number(self, name, default):
        try:
            value = float(self.get(name))
            return value if isfinite(value) else default
        except (ValueError, TypeError):
            return default

    def enabled(self, name, default=True):
        return str(self.get(name, "1" if default else "0")).lower().strip() not in {"0", "false", "no", "off"}

    def ids(self, name):
        return {int(p) for p in re.split(r"[,，\s]+", self.get(name)) if p.isdecimal() and int(p) > 0}

    def save(self, patch):
        for key, value in patch.items():
            if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or any(c in str(value) for c in "\r\n\x00"):
                raise ValueError("配置键或值无效")
            if key in self.environ and str(self.environ[key]) != str(value):
                raise ValueError(f"{key}被进程环境覆盖，请先解除该环境覆盖")
        old = self.env_file.read_text(encoding="utf-8-sig") if self.env_file.exists() else ""
        remaining, lines = dict(patch), []
        for line in old.splitlines():
            match = re.match(r"^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=", line)
            if match and match[1] in patch:
                if match[1] in remaining:
                    lines.append(f"{match[1]}={remaining.pop(match[1])}")
            else:
                lines.append(line)
        lines.extend(f"{key}={value}" for key, value in remaining.items())
        write_text(self.env_file, "\n".join(lines) + "\n")
        self.values.update({key: str(value) for key, value in patch.items()})
        self.values.update(self.environ)

    def persona(self, name=""):
        if not name and self.get('PERSONA').strip():
            return self.get('PERSONA').strip()
        name = name or self.get("ACTIVE_PERSONA")
        if name:
            if not re.fullmatch(r'[^\\/:*?"<>|\x00-\x1f]{1,60}', name) or name.endswith((".", " ")) or name in {".", ".."}:
                raise ValueError("人格名称无效")
            directory = Path(self.get("PERSONA_DIR", str(self.data_dir / "personas")))
            if not directory.is_absolute():
                directory = self.env_file.parent / directory
            file = directory / f'{name}.txt'
            if file.is_symlink() or directory.is_symlink():
                raise ValueError('人格文件不支持链接')
            text = file.read_text(encoding='utf-8-sig').strip()
            if not text: raise ValueError('当前人格正文为空')
            return text
        explicit = self.get('PERSONA_FILE')
        file = Path(explicit) if explicit else self.data_dir/'persona.txt'
        if explicit and not file.is_absolute(): file = self.env_file.parent/file
        if not explicit and not file.exists(): file = self.root/'persona.txt'
        if file.is_symlink(): raise ValueError('人格文件不支持链接')
        text = file.read_text(encoding='utf-8-sig').strip() if file.exists() else ''
        return text.replace('{{BOT_NAME}}',self.get('BOT_NAME','Koukou')) if text else '你是友善的QQ群聊小助手。尊重他人，不编造已执行的动作。'
