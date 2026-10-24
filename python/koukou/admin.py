"""Native aiohttp control server, serving the existing HTML/CSS/JS frontend."""
import hmac
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit
from . import __version__
from .migration import report
from .state import read_json, write_json, write_text


class Admin:
    def __init__(self, config, plugins, memory, long_memory):
        self.config, self.plugins, self.memory, self.long_memory = config, plugins, memory, long_memory
        self.token = secrets.token_urlsafe(32)
        self.started = time.time()
        self.chat_file = config.data_dir / "chat-settings.json"
        self.settings = read_json(self.chat_file, {})
        self.schema = json.loads(Path(__file__).with_name("admin_schema.json").read_text(encoding="utf-8-sig"))
        self.gets = {
            "/api/state": self.state, "/api/config": self.get_config, "/api/python-scripts": self.get_plugins,
            "/api/chats": self.get_chats, "/api/memory": self.get_memory, "/api/longmemory": self.get_long,
            "/api/migration": self.get_migration,
        }
        self.actions = {
            "set-config": self.set_config, "set-config-batch": self.set_config_batch,
            "read-python-script": self.read_script, "import-python-script": self.import_script,
            "toggle-python-script": self.toggle_script, "delete-python-script": self.delete_script,
            "set-python-command": self.set_command, "save-python-settings": self.save_plugin_settings,
            "python-new-script": self.new_script,
            "set-chat": self.set_chat, "reset-chat": self.reset_chat,
            "memory-update": self.memory_update, "memory-delete": self.memory_delete,
            "longmemory-update": self.long_update, "longmemory-pause": self.long_pause,
            "longmemory-resume": self.long_resume,
        }

    async def state(self, _):
        return {"now": time.time()*1000, "version": __version__ + "-python-migration", "pid": os.getpid(),
                "uptimeSec": int(time.time()-self.started),
                "bot": {"connected": False, "online": False, "probeVerified": False, "selfId": "", "model": self.config.get("DEEPSEEK_MODEL", "deepseek-flash")},
                "config": {"whitelistGroups": sorted(self.config.ids("WHITELIST_GROUPS")),
                    "adminUsers": sorted(self.config.ids("ADMIN_USERS")), "quietHours": self.config.get("QUIET_HOURS"),
                    "proactiveRate": self.config.number("PROACTIVE_RATE", .04)},
                "today": {"total": 0, "perGroup": []}, "summaryProgress": [], "replies": 0,
                "today_replies": 0, "counters": {}, "migration": self.get_migration({})}

    def get_migration(self, _):
        return report(self.config.root, self.gets, self.actions)

    def get_config(self, _):
        return {"items": [{**field, "value": "" if field["type"] == "secret" else self.config.get(field["key"]),
                           "effective": "" if field["type"] == "secret" else self.config.get(field["key"]),
                           "configured": bool(self.config.get(field["key"])) if field["type"] == "secret" else None} for field in self.schema]}

    def get_plugins(self, _):
        return {"dir": str(self.plugins.directory), "items": self.plugins.list(), "settings": self.plugins.settings()}

    def get_chats(self, _):
        keys = set(self.settings) | set(self.memory.chats)
        return {"items": [{"key": key, "id": key[1:], "type": "group" if key.startswith("g") else "private",
            "name": self.settings.get(key, {}).get("note", key), "raw": self.settings.get(key, {}),
            "effective": {"enabled": True, "atReplyEnabled": True, "proactiveEnabled": True, **self.settings.get(key, {})},
            "memoryCount": len(self.memory.get(key))} for key in sorted(keys)]}

    def get_memory(self, q):
        return {"items": self.memory.get(q.get("key", ""))}

    def get_long(self, q):
        return self.long_memory.record(q.get("key", ""))

    def set_config(self, p):
        return self.set_config_batch({"patch": {p["key"]: p.get("value", "")}})

    def set_config_batch(self, p):
        patch = p.get("patch", {})
        allowed = {field["key"]: field for field in self.schema}
        if not isinstance(patch, dict) or len(patch) > 80 or set(patch) - set(allowed):
            raise ValueError("配置项无效")
        # Preserve secret values on blank submissions, as the existing UI expects.
        clean = {key: str(value) for key, value in patch.items() if value != "" or allowed[key]["type"] != "secret"}
        if "DEEPSEEK_REASONING_EFFORT" in clean and clean["DEEPSEEK_REASONING_EFFORT"] != "max":
            raise ValueError("Python版DeepSeek调用统一使用max")
        for key, value in clean.items():
            if allowed[key]["type"] in {"number", "rate"}:
                import math
                if not math.isfinite(float(value)):
                    raise ValueError("数值配置无效")
        self.config.save(clean)
        live = sum(bool(allowed[key].get("live")) for key in clean)
        return {"ok": True, "changed": len(clean), "live": live, "needRestart": live < len(clean)}

    def read_script(self, p):
        return {"content": self.plugins.path(p["id"]).read_text(encoding="utf-8-sig")}

    def import_script(self, p):
        return {"ok": True, "item": self.plugins.import_script(p["filename"], p["content"], overwrite=True)}

    def new_script(self, p):
        return {"ok": True, "item": self.plugins.create(p["name"], p.get("description", "自定义指令"))}

    def toggle_script(self, p):
        return {"enabled": self.plugins.set_enabled(p["id"], p.get("enabled") is True)}

    def delete_script(self, p):
        self.plugins.path(p["id"]).unlink()
        return {"ok": True}

    def set_command(self, p):
        key, name = p["id"], p.get("command", "").strip()
        self.plugins.path(key)
        import re
        if name and (not re.fullmatch(r"[\w-]{1,20}", name) or name.lower() in {"list", "help", "列表", "帮助", "指令", "命令"}):
            raise ValueError("调用名无效或是保留词")
        settings = self.plugins.settings()
        if any(alias == name and other != key for other, alias in settings["names"].items()) or (name != key and re.fullmatch(r"[A-Za-z0-9_-]+", name or "") and self.plugins.path(name).exists()):
            raise ValueError("调用名已占用")
        if name and name != key:
            settings["names"][key] = name
        else:
            settings["names"].pop(key, None)
        write_json(self.plugins.directory / "settings.json", settings)
        return {"ok": True, "command": name or key}

    def save_plugin_settings(self, p):
        settings = self.plugins.settings()
        if "recallSeconds" in p:
            seconds = int(p["recallSeconds"])
            if not 5 <= seconds <= 7200:
                raise ValueError("撤回时间需在5~7200秒")
            settings["recallSeconds"] = seconds
        if "recallEnabled" in p:
            settings["recallEnabled"] = p["recallEnabled"] is True
        write_json(self.plugins.directory / "settings.json", settings)
        return {"ok": True, "settings": settings}

    def set_chat(self, p):
        from .memory import valid_key
        key = valid_key(p["key"])
        patch = p.get("patch", {})
        if not isinstance(patch, dict):
            raise ValueError("会话设置格式错误")
        self.settings[key] = {**self.settings.get(key, {}), **patch}
        write_json(self.chat_file, self.settings)
        return {"ok": True}

    def reset_chat(self, p):
        self.settings.pop(p["key"], None)
        write_json(self.chat_file, self.settings)
        return {"ok": True}

    def memory_update(self, p):
        self.memory.edit(p["key"], p["index"], p["content"])
        return {"ok": True}

    def memory_delete(self, p):
        self.memory.edit(p["key"], p["index"], delete=True)
        return {"ok": True}

    def long_update(self, p):
        return {"ok": True, **self.long_memory.edit(p["key"], p.get("summary", ""), paused=True)}

    def long_pause(self, p):
        return {"ok": True, **self.long_memory.edit(p["key"], paused=True)}

    def long_resume(self, p):
        return {"ok": True, **self.long_memory.edit(p["key"], paused=False)}

    def app(self):
        from aiohttp import web
        import inspect
        assets = self.config.root / "src" / "admin"

        async def dispatch(request):
            host = request.headers.get("Host", "")
            hostname = urlsplit("http://" + host).hostname
            if hostname not in {"127.0.0.1", "localhost", "::1"}:
                return web.json_response({"error": "Host无效"}, status=403)
            path = request.path
            if request.method == "GET" and path in {"/", "/index.html"}:
                source = (assets / "ui.html").read_text(encoding="utf-8-sig")
                banner = '<div style="padding:12px;background:#854d0e;color:white">Python迁移预览：QQ连接已禁用，未迁移接口会明确返回501。</div>'
                source = source.replace("<body>", "<body>" + banner + "<script>window.__ADMIN_TOKEN__=" + json.dumps(self.token) + "</script>")
                return web.Response(text=source, content_type="text/html")
            static = {"/ui.css": "ui.css", "/app.js": "app.js", "/command-center.js": "commandCenter.js", "/sticker-upload.js": "stickerUpload.js"}
            if request.method == "GET" and path in static:
                return web.FileResponse(assets / static[path])
            try:
                if request.method == "GET" and path in self.gets:
                    result = self.gets[path](dict(request.query))
                    return web.json_response(await result if inspect.isawaitable(result) else result)
                if request.method == "POST" and path.startswith("/api/"):
                    if not hmac.compare_digest(request.headers.get("X-Admin-Token", ""), self.token):
                        return web.json_response({"error": "未授权"}, status=401)
                    origin = request.headers.get("Origin")
                    if origin and origin != request.scheme + "://" + host:
                        return web.json_response({"error": "Origin无效"}, status=403)
                    if request.content_type != "application/json":
                        return web.json_response({"error": "仅支持application/json"}, status=415)
                    action = path.removeprefix("/api/action/") if path.startswith("/api/action/") else path.removeprefix("/api/")
                    if action not in self.actions:
                        return web.json_response({"error": "该接口尚未迁移到Python", "action": action}, status=501)
                    body = await request.json()
                    if not isinstance(body, dict):
                        raise ValueError("请求体必须为对象")
                    result = self.actions[action](body)
                    return web.json_response(await result if inspect.isawaitable(result) else result)
                return web.json_response({"error": "该接口尚未迁移到Python"}, status=501 if path.startswith("/api/") else 404)
            except (ValueError, SyntaxError, KeyError, OSError) as exc:
                return web.json_response({"error": str(exc)}, status=400)

        app = web.Application(client_max_size=16 * 1024 * 1024)
        app.router.add_route("*", "/{path:.*}", dispatch)
        return app
