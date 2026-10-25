"""Native plugin manager; legacy standalone scripts and the new SDK share one runner."""
import asyncio
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
from .state import read_json, write_json, write_text

NAME = re.compile(r"[a-zA-Z0-9_-]{1,40}")


class PluginManager:
    def __init__(self, root, config=None, executable=None):
        self.root, self.config = Path(root).resolve(), config
        self.directory = self.root / "plugins" / "python"
        self.executable = executable or sys.executable

    def path(self, name):
        name = str(name).removesuffix(".py")
        if not NAME.fullmatch(name):
            raise ValueError("脚本名只能包含字母、数字、下划线、短横线，1~40字符")
        file = self.directory / (name + ".py")
        if file.is_symlink() or file.resolve().parent != self.directory.resolve():
            raise ValueError("插件文件必须位于插件目录，不能是外部链接")
        return file

    def settings(self):
        data = read_json(self.directory / "settings.json", {})
        if not isinstance(data, dict) or not isinstance(data.get("names", {}), dict):
            raise ValueError("插件设置格式错误，请恢复备份")
        return {"recallSeconds": data.get("recallSeconds", data.get("recallMinutes", 5) * 60),
                "recallEnabled": data.get("recallEnabled", True), "names": data.get("names", {})}

    def enabled(self, name):
        disabled = read_json(self.directory / "disabled.json", [])
        if not isinstance(disabled, list):
            raise ValueError("插件停用设置损坏")
        return name not in disabled

    def set_enabled(self, name, enabled):
        self.path(name)
        disabled = set(read_json(self.directory / "disabled.json", []))
        disabled.discard(name) if enabled else disabled.add(name)
        write_json(self.directory / "disabled.json", sorted(disabled))
        return enabled

    def resolve(self, name):
        if NAME.fullmatch(name) and self.path(name).is_file():
            return name
        return next((key for key, alias in self.settings()["names"].items() if alias == name), name)

    def validate_command(self, command, owner):
        from types import SimpleNamespace
        from .commands import CommandRegistry
        config = self.config or SimpleNamespace(data_dir=self.root / "data-python")
        CommandRegistry(config, self).validate_name(command, owner)

    def set_command(self, name, command):
        if not self.path(name).is_file():
            raise ValueError("插件不存在")
        command = str(command).strip() or name
        self.validate_command(command, name)
        settings = self.settings()
        if command == name:
            settings["names"].pop(name, None)
        else:
            settings["names"][name] = command
        write_json(self.directory / "settings.json", settings)
        return command

    def metadata(self, name):
        file = self.path(name)
        result = {"id": name, "name": name, "description": "", "usage": "", "admin": False,
                  "commands": [], "path": str(file), "size": file.stat().st_size,
                  "enabled": self.enabled(name), "command": self.settings()["names"].get(name, name)}
        for line in file.read_text(encoding="utf-8-sig").splitlines()[:30]:
            match = re.match(r"\s*#\s*(name|desc|description|usage|admin|cmd)\s*[:：]\s*(.+)", line, re.I)
            if not match:
                continue
            key, value = match[1].lower(), match[2].strip()
            if key in {"desc", "description"}:
                result["description"] = value
            elif key == "admin":
                result["admin"] = value.lower() in {"1", "true", "yes", "是"}
            elif key == "cmd":
                usage, _, description = value.partition("|")
                result["commands"].append({"usage": usage.strip(), "desc": description.strip()})
            else:
                result[key] = value
        result["usage"] = re.sub(r"[/／]py\s+\S+", lambda _: "/" + result["command"], result["usage"], flags=re.I)
        result["usage"] = re.sub(r"[/／]" + re.escape(name) + r"(?=\s|$)", lambda _: "/" + result["command"], result["usage"], flags=re.I)
        return result

    def list(self):
        if not self.directory.exists():
            return []
        return [self.metadata(p.stem) for p in sorted(self.directory.glob("*.py")) if NAME.fullmatch(p.stem)]

    def import_script(self, filename, content, *, overwrite=False):
        if not str(filename).endswith(".py"):
            raise ValueError("文件名必须以.py结尾")
        file = self.path(str(filename)[:-3])
        if not content.strip() or len(content.encode("utf-8")) > 200 * 1024:
            raise ValueError("脚本内容为空或超过200KB")
        compile(content, filename, "exec")  # Syntax checking, not executing uploaded code.
        if not file.exists():
            self.validate_command(file.stem, file.stem)
        if file.exists():
            if not overwrite:
                raise FileExistsError("脚本已存在，请明确选择覆盖")
            write_text(file.with_suffix(".py.bak"), file.read_text(encoding="utf-8-sig"))
        write_text(file, content)
        return self.metadata(file.stem)

    def create(self, name, description="自定义Python指令"):
        self.path(name)
        # JSON quoting keeps arbitrary description text out of executable Python syntax.
        content = f'''# name: {name}
# desc: {description.replace(chr(10), ' ').replace(chr(13), ' ')}
# usage: /{name} 内容
# admin: false
from koukou.plugin import plugin


@plugin.command
def handle(args: list[str]) -> str:
    """直接返回想发送的文字；支持async def，也可返回Result。"""
    return "收到：" + " ".join(args) if args else "你好！插件已经可以使用。"


if __name__ == "__main__":
    plugin.run()
'''
        return self.import_script(name + ".py", content)

    async def run(self, name, raw_args="", *, timeout=None):
        name = self.resolve(name)
        file = self.path(name)
        if not file.is_file() or not self.enabled(name):
            raise ValueError("插件不存在或已停用")
        if isinstance(raw_args, list):
            if any(not isinstance(value, str) for value in raw_args):
                raise ValueError("插件参数必须是字符串")
            argv = raw_args
        else:
            args = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"|\x27([^\x27]*)\x27|(\S+)', raw_args)
            argv = [next(value for value in match if value != "") if any(match) else "" for match in args]
        # Match legacy argv splitting: quoted Windows paths keep their backslashes.
        if len(argv) > 20:
            raise ValueError("最多20个参数")
        header = file.read_text(encoding="utf-8-sig")[:4096]
        match = re.search(r"^#\s*timeout-ms:\s*(\d{3,6})\s*$", header, re.M | re.I)
        seconds = timeout if timeout is not None else min(600, max(1, int(match[1]) / 1000)) if match else 20
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        source = str(Path(__file__).resolve().parents[1])
        env["PYTHONPATH"] = source + os.pathsep + env.get("PYTHONPATH", "")
        if self.config:
            for name, key, default in [("FORMAT", "ARCHIVE_FORMAT", "zip"), ("PASSES", "ARCHIVE_PASSES", "1"),
                    ("FILE_MAX_MB", "FILE_UPLOAD_MAX_MB", "1024"), ("FILE_SPLIT_MB", "FILE_SPLIT_MB", "90"),
                    ("SEVEN_ZIP", "SEVEN_ZIP_PATH", ""), ("RAR", "RAR_PATH", "")]:
                env["KOUKOU_ARCHIVE_" + name if name in {"FORMAT", "PASSES"} else "KOUKOU_" + name] = str(self.config.get(key, default))
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
        process = await asyncio.create_subprocess_exec(self.executable, "-X", "utf8", str(file), *argv,
            cwd=self.directory, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **options)

        async def read(stream):
            chunks, size = [], 0
            while chunk := await stream.read(65536):
                size += len(chunk)
                if size > 1024 * 1024:
                    raise ValueError("插件输出超过1MB")
                chunks.append(chunk)
            return b"".join(chunks).decode("utf-8", errors="replace").strip()

        async def kill():
            # Release StreamReader ownership before draining killed children's pipes.
            # Waiting for a child with a full unread stdout pipe can otherwise deadlock.
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if process.returncode is None:
                if os.name == "nt":
                    killer = await asyncio.create_subprocess_exec("taskkill", "/PID", str(process.pid), "/T", "/F",
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
                    await killer.wait()
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            await process.communicate()

        tasks = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr)), asyncio.create_task(process.wait())]
        try:
            stdout, stderr, code = await asyncio.wait_for(asyncio.gather(*tasks), seconds)
            return {"ok": code == 0, "code": code, "stdout": stdout, "stderr": stderr, "killed": False}
        except (TimeoutError, ValueError):
            await kill()
            return {"ok": False, "code": -1, "stdout": "", "stderr": "插件超时或输出超限", "killed": True}
        except BaseException:
            await kill()
            raise
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


def decode_result(result):
    output = result.get("stdout") or result.get("stderr") or "（没有输出）"
    if not result.get("ok"):
        return {"text": "插件执行失败：" + output, "images": [], "files": []}
    if output.startswith("@@KOUKOU@@"):
        data = json.loads(output[len("@@KOUKOU@@"):])
        if not isinstance(data, dict) or any(not isinstance(data.get(key, []), list) for key in ("images", "files")):
            raise ValueError("插件Result格式错误")
        return {"text": str(data.get("text", "")), "images": data.get("images", []), "files": data.get("files", [])}
    if output.startswith("@@CARD@@"):
        return {"legacyCard": json.loads(output[len("@@CARD@@"):])}
    if output.startswith("@@FILE@@"):
        return {"legacyFile": json.loads(output[len("@@FILE@@"):])}
    return {"text": output, "images": [], "files": []}
