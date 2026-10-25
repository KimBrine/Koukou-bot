"""Native aiohttp control server, serving the existing HTML/CSS/JS frontend."""
import hmac
import json
import os
from pathlib import Path
import secrets
import time
import copy
import re
import uuid
from urllib.parse import urlsplit
from . import __version__
from .migration import report
from .state import read_json, write_json, write_text
from .commands import CommandRegistry
from .archive import stamp
from .sessions import Sessions, digest, persona_text
from .greetings import GreetingLibrary
from .backup import Backup
from .custom import CustomCommands, clean
from .commands import split_request, normalize, RESERVED
from .quiet_greetings import QuietGreetings
from .summary_service import SummaryService


class Admin:
    def __init__(self, config, plugins, memory, long_memory, *, onebot=None, model=None):
        self.config, self.plugins, self.memory, self.long_memory = config, plugins, memory, long_memory
        self.onebot, self.model = onebot, model
        self.group_names, self.friend_names = {}, {}
        plugins.config = config
        self.commands = CommandRegistry(config, plugins)
        self.token = secrets.token_urlsafe(32)
        self.started = time.time()
        self.chat_file = config.data_dir / "chat-settings.json"
        self.settings = read_json(self.chat_file, {})
        self.sessions = Sessions(config, memory, long_memory, self.settings)
        self.greetings = GreetingLibrary(config.data_dir / "persona-greetings.json")
        self.backup = Backup(config)
        self.custom = CustomCommands(config.data_dir / "custom-commands.json")
        self.quiet_greetings = QuietGreetings(config, onebot, memory, self.settings, self.greetings) if onebot else None
        self.summaries = SummaryService(config, onebot, model, memory, self.settings) if onebot else None
        self.schema = json.loads(Path(__file__).with_name("admin_schema.json").read_text(encoding="utf-8-sig"))
        self.gets = {
            "/api/state": self.state, "/api/config": self.get_config, "/api/python-scripts": self.get_plugins,
            "/api/chats": self.get_chats, "/api/memory": self.get_memory, "/api/longmemory": self.get_long,
            "/api/migration": self.get_migration,
            "/api/commands": self.get_commands, "/api/custom-commands": self.get_commands,
            "/api/personas": self.get_personas, "/api/memory-detail": self.memory_detail,
            "/api/memory-overview": self.memory_overview, "/api/memory-export": self.memory_export,
            "/api/poke-replies": self.get_poke_replies,
            "/api/backups": lambda _: {"items": self.backup.list(), "root": str(self.backup.root)},
            "/api/groups": self.get_groups, "/api/friends": self.get_friends,
            "/api/daily": self.get_daily,
        }
        self.actions = {
            "set-config": self.set_config, "set-config-batch": self.set_config_batch,
            "read-python-script": self.read_script, "import-python-script": self.import_script,
            "toggle-python-script": self.toggle_script, "delete-python-script": self.delete_script,
            "set-python-command": self.set_command, "save-python-settings": self.save_plugin_settings,
            "python-new-script": self.new_script,
            "save-builtin-command": self.save_builtin,
            "set-chat": self.set_chat, "reset-chat": self.reset_chat,
            "memory-update": self.memory_update, "memory-delete": self.memory_delete,
            "longmemory-update": self.long_update, "longmemory-pause": self.long_pause,
            "longmemory-resume": self.long_resume,
            "pending-delete": self.pending_delete, "memory-import": self.memory_import,
            "update-whitelist": self.update_whitelist, "add-private-whitelist": self.add_private,
            "get-persona": self.get_persona, "save-persona": self.save_persona,
            "create-persona": self.create_persona, "import-persona": self.import_persona,
            "delete-persona": self.delete_persona, "activate-persona": self.activate_persona,
            "export-persona": self.export_persona, "export-persona-package": self.export_persona_package,
            "get-greeting-library": self.get_greetings, "save-greeting-library": self.save_greetings,
            "save-poke-replies": self.save_poke_replies,
            "backup": lambda _: {"ok": True, **self.backup.run()},
            "restore-backup": lambda p: self.backup.queue_restore(p["name"]),
            "save-custom-command": self.save_custom, "delete-custom-command": self.delete_custom,
            "export-commands": self.export_commands, "preview-commands": self.preview_commands,
            "import-commands": self.import_commands,
            "send-morning-greetings": self.send_morning,
            "summary": self.summary, "summary-ack": self.summary_ack,
        }

    async def state(self, _):
        return {"now": time.time()*1000, "version": __version__ + "-python-migration", "pid": os.getpid(),
                "uptimeSec": int(time.time()-self.started),
                "bot": {**(self.onebot.status() if self.onebot else {"connected": False, "online": False, "probeVerified": False, "selfId": ""}), "model": self.config.get("DEEPSEEK_MODEL", "deepseek-flash")},
                "config": {"whitelistGroups": sorted(self.config.ids("WHITELIST_GROUPS")),
                    "adminUsers": sorted(self.config.ids("ADMIN_USERS")), "quietHours": self.config.get("QUIET_HOURS"),
                    "proactiveRate": self.config.number("PROACTIVE_RATE", .04), "quietGreetings": self.quiet_greetings.status() if self.quiet_greetings else {"enabled": self.config.enabled('QUIET_GREETINGS_ENABLED', False), "blocked": True, "groups": []}},
                "today": {"total": 0, "perGroup": []}, "summaryProgress": list(self.summaries.progress.items.values()) if self.summaries else [], "replies": 0,
                "today_replies": 0, "counters": {}, "migration": self.get_migration({})}

    async def protocol_read(self, action):
        if self.onebot is None or not self.onebot.status().get('online'):
            raise RuntimeError('QQ实际在线状态尚未确认')
        session = self.onebot.timeline.session
        result = await self.onebot.api(action)
        if session != self.onebot.timeline.session or not self.onebot.status().get('online'):
            raise RuntimeError('读取期间QQ连接变化，请刷新')
        if not isinstance(result, list):
            raise ValueError('QQ返回的名单格式无效')
        return result

    async def get_groups(self, _):
        items = [{'id': str(v['group_id']), 'name': v.get('group_name', ''), **v} for v in await self.protocol_read('get_group_list') if isinstance(v, dict) and v.get('group_id')]
        self.group_names = {v['id']: v['name'] for v in items}
        return {'items': items}

    async def get_friends(self, _):
        items = [{'id': str(v['user_id']), 'name': v.get('remark') or v.get('nickname', ''), **v} for v in await self.protocol_read('get_friend_list') if isinstance(v, dict) and v.get('user_id')]
        self.friend_names = {v['id']: v['name'] for v in items}
        return {'items': items}

    async def send_morning(self, _):
        if self.quiet_greetings is None:
            raise RuntimeError('当前仅为控制台预览，QQ连接已禁用')
        return await self.quiet_greetings.catch_up_morning()

    def summary(self, p):
        if self.summaries is None:
            raise RuntimeError('当前仅为控制台预览，QQ连接已禁用')
        if p.get('missingOnly'):
            raise RuntimeError('定时漏发核验尚未迁移，未提交补发任务')
        group = p.get('groupId')
        return self.summaries.trigger([group] if group else None, days=max(1, min(30, int(p.get('days') or 1))), statistics=p.get('statsOnly') is True)

    def summary_ack(self, p):
        if self.summaries is None:
            raise RuntimeError('群总结服务未连接QQ')
        return {'ok': True, 'acknowledged': self.summaries.progress.acknowledge(p['groupId'], p['jobId']), 'progress': list(self.summaries.progress.items.values())}

    def get_daily(self, _):
        root, items = self.config.data_dir / 'daily', []
        if root.exists():
            for directory in root.iterdir():
                if directory.is_symlink() or not directory.is_dir() or not directory.name.isdecimal():
                    continue
                for file in sorted(directory.glob('*.jsonl'), reverse=True)[:14]:
                    if file.is_symlink() or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', file.stem):
                        continue
                    items.append({'groupId': directory.name, 'date': file.stem, 'size': file.stat().st_size})
        return {'items': items}

    def get_migration(self, _):
        return report(self.config.root, self.gets, self.actions)

    def get_config(self, _):
        return {"items": [{**field, "value": "" if field["type"] == "secret" else self.config.get(field["key"]),
                           "effective": "" if field["type"] == "secret" else self.config.get(field["key"]),
                           "configured": bool(self.config.get(field["key"])) if field["type"] == "secret" else None} for field in self.schema]}

    def get_plugins(self, _):
        return {"dir": str(self.plugins.directory), "items": self.plugins.list(), "settings": self.plugins.settings(), "nativeCommands": True}

    def get_commands(self, _):
        return {"items": self.custom.all(), "builtinItems": self.commands.all(), "nativeCommands": True}

    def validate_custom(self, item):
        for trigger in [item["trigger"], *item["aliases"]]:
            request = split_request(trigger)
            if request and (request[0] in RESERVED or any(request[0] in {normalize(p["command"]), normalize(p["pluginId"])} for p in self.commands.plugin_entries())):
                raise ValueError("触发词与已有内置或插件指令冲突")
        return item

    def save_custom(self, p):
        item = self.validate_custom(clean(p))
        return {"ok": True, "item": self.custom.upsert(item)}

    def delete_custom(self, p):
        self.custom.remove(p["id"])
        return {"ok": True}

    def export_commands(self, p):
        def redact(item):
            item = copy.deepcopy(item)
            if p.get("includeGroups") is not True:
                item.update(groups=[], scheduleGroups=[])
            return item
        id = p.get("id")
        commands = [redact(c) for c in self.custom.all() if not id or c["id"] == id]
        builtins = [redact(c) for c in self.commands.all() if not id or c["id"] == id]
        if id and not commands and not builtins:
            raise ValueError("指令不存在")
        return {"format": "koukou.commands", "version": 1, "commands": commands, "builtins": builtins}

    def preview_commands(self, p):
        text = p.get("content")
        if not isinstance(text, str) or len(text) > 262144:
            raise ValueError("指令文件须小于256KB")
        value = json.loads(text.removeprefix("\ufeff"))
        if not isinstance(value, dict) or value.get("format") != "koukou.commands" or value.get("version") != 1 or not isinstance(value.get("commands"), list) or not isinstance(value.get("builtins", []), list):
            raise ValueError("指令格式或版本不支持")
        if len(value["commands"]) > 200 or len(value.get("builtins", [])) > 200:
            raise ValueError("指令数量过多")
        commands = [self.validate_custom(clean({**c, "id": str(uuid.uuid4()), "enabled": False, "scheduleEnabled": False, "naturalLanguage": False})) for c in value["commands"] if isinstance(c, dict)]
        if len(commands) != len(value["commands"]):
            raise ValueError("指令条目格式错误")
        builtins = []
        for item in value.get("builtins", []):
            if not isinstance(item, dict) or not self.commands.get(item.get("id")):
                raise ValueError("包含尚未迁移或未知内置指令")
            builtins.append({k: item[k] for k in ["id", "scope", "groups", "adminOnly", "responseMode"] if k in item} | {"enabled": False})
        return {"commands": commands, "builtins": builtins}

    def import_commands(self, p):
        pack = self.preview_commands(p)
        def mutate():
            old = self.custom.all()
            names = {c["name"] for c in old}
            for item in pack["commands"]:
                base, n = item["name"], 2
                while item["name"] in names:
                    item["name"] = base[:28]+f"（导入{n}）"; n += 1
                names.add(item["name"])
            self.custom.replace(old+pack["commands"])
            if p.get("includeBuiltins") is True:
                for item in pack["builtins"]:
                    self.commands.save_builtin(item)
            return {"ok": True, "added": len(pack["commands"]), "builtins": len(pack["builtins"]) if p.get("includeBuiltins") is True else 0}
        return self.sessions.transaction("导入指令", mutate)

    def save_builtin(self, payload):
        return {"ok": True, "item": self.commands.save_builtin(payload)}

    def get_chats(self, _):
        keys = set(self.settings) | set(self.memory.chats) | {'g'+str(id) for id in self.config.ids('WHITELIST_GROUPS')} | {'p'+str(id) for id in self.config.ids('PRIVATE_WHITELIST') | self.config.ids('ADMIN_USERS')}
        items = []
        for key in sorted(keys):
            raw = self.settings.get(key, {})
            group, id = key.startswith('g'), key[1:]
            effective = {'enabled': True, 'atReplyEnabled': True, 'proactiveEnabled': True, **raw}
            for field, env, default in [('proactiveRate', 'PROACTIVE_RATE', .04), ('emojiKeepRate', 'EMOJI_KEEP_RATE', .35), ('replyMaxLines', 'REPLY_MAX_LINES', 3), ('lineMaxChars', 'REPLY_LINE_MAX_CHARS', 40)]:
                if effective.get(field) is None:
                    effective[field] = self.config.number(env, default)
            if effective.get('quietHours') is None:
                effective['quietHours'] = self.config.get('QUIET_HOURS')
            count = len(self.memory.get(key))
            items.append({'key': key, 'id': id, 'type': 'group' if group else 'private', 'name': raw.get('note') or (self.group_names if group else self.friend_names).get(id) or ('群 ' if group else 'QQ ')+id,
                          'inWhitelist': group and int(id) in self.config.ids('WHITELIST_GROUPS'), 'raw': raw, 'effective': effective, 'memory': count, 'memoryCount': count,
                          'privateAccess': None if group else {'listed': int(id) in self.config.ids('PRIVATE_WHITELIST'), 'admin': int(id) in self.config.ids('ADMIN_USERS'), 'configured': key in self.settings}, 'persona': raw.get('persona', '')})
        return {'items': items}

    def get_memory(self, q):
        return {"items": self.memory.get(q.get("key", ""))}

    def get_long(self, q):
        key = q.get("key", "")
        return {"key": key or None, "text": self.long_memory.text(key, q.get("q", "")[:500]) if key else ""}

    def memory_detail(self, q):
        key = q["key"]
        all = self.memory.get(key)
        record = self.long_memory.record(key)
        pending = record.get("pending", [])
        return {"key": key, "recent": all[-200:], "recentOffset": max(0, len(all)-200), "revision": stamp(all),
                "pendingRevision": stamp(pending), "longTerm": record.get("summary", ""), "updatedAt": record.get("updatedAt", 0),
                "pending": pending, "paused": record.get("paused", False), "running": key in self.long_memory.running}

    def memory_overview(self, _):
        keys = set(self.memory.chats) | set(self.long_memory.chats) | set(self.settings)
        items = [{"key": key, "recent": len(self.memory.get(key)), "longTermChars": len(self.long_memory.record(key).get("summary", "")),
                  "pending": len(self.long_memory.record(key).get("pending", []))} for key in keys]
        return {"persona": self.config.get("ACTIVE_PERSONA"), "items": sorted(items, key=lambda x: x["recent"]+x["longTermChars"], reverse=True)}

    def memory_export(self, _):
        return {"version": 1, "exportedAt": time.time()*1000, "persona": self.config.get("ACTIVE_PERSONA"),
                "memory": copy.deepcopy(self.memory.chats), "longMemory": copy.deepcopy(self.long_memory.chats)}

    def memory_import(self, p):
        data = p.get("data")
        if not isinstance(data, dict) or data.get("persona", self.config.get("ACTIVE_PERSONA")) != self.config.get("ACTIVE_PERSONA"):
            raise ValueError("导入格式无效或人格不同")
        mem, long = data.get("memory"), data.get("longMemory")
        if mem is None and long is None:
            raise ValueError("没有记忆可导入")
        from .memory import valid_key
        for collection, recent in [(mem, True), (long, False)]:
            if collection is None:
                continue
            if not isinstance(collection, dict):
                raise ValueError("记忆格式错误")
            for key, value in collection.items():
                valid_key(key)
                if recent:
                    valid = isinstance(value, list) and all(isinstance(e, dict) and e.get("role") in {"user", "assistant", "system"} and isinstance(e.get("content"), str) and isinstance(e.get("time", 0), (float, int)) for e in value)
                else:
                    valid = isinstance(value, dict) and isinstance(value.get("summary"), str) and isinstance(value.get("pending"), list) and all(isinstance(e, dict) and isinstance(e.get("text"), str) for e in value["pending"])
                if not valid:
                    raise ValueError("记忆条目格式错误")
        def mutate():
            if mem is not None:
                self.memory.restore({"chats": mem, "resetAt": 0, "keyResetAt": {}})
            if long is not None:
                self.long_memory.restore({"chats": long, "epoch": str(uuid.uuid4()), "keyEpochs": {}})
            return {"ok": True, "recentKeys": len(mem or {}), "longKeys": len(long or {})}
        return self.sessions.transaction("导入记忆", mutate)

    def update_whitelist(self, p):
        if p.get("operation") not in {"add", "remove"}:
            raise ValueError("不支持的白名单操作")
        return self.whitelist("WHITELIST_GROUPS", p.get("groupIds"), p["operation"])

    def add_private(self, p):
        return self.whitelist("PRIVATE_WHITELIST", p.get("userIds"), "add")

    def whitelist(self, name, values, operation):
        if not isinstance(values, list) or not 1 <= len(values) <= 200 or any(not re.fullmatch(r"[1-9]\d{4,11}", str(v).strip()) for v in values):
            raise ValueError("请输入1~200个有效的5~12位号码")
        old = self.config.ids(name); ids = set(map(int, values))
        next = old | ids if operation == "add" else old - ids
        self.config.save({name: ",".join(map(str, sorted(next)))})
        return {"ok": True, "changed": len(old ^ next), "whitelist": sorted(next)}

    def get_personas(self, _):
        return {"items": self.sessions.list(), "active": self.config.get("ACTIVE_PERSONA"), "dir": str(self.sessions.directory)}

    def get_persona(self, p):
        path = self.sessions.path(p["name"])
        return {"name": p["name"], "content": self.sessions.read(p["name"]) if path.exists() else ""}

    def save_persona(self, p):
        return self.sessions.save(p["name"], p.get("content"))

    def create_persona(self, p):
        return self.sessions.save(p["name"], p.get("content", "你是群里的一员。"), create=True)

    def import_persona(self, p):
        content = persona_text(p.get("content"))
        # Validate the library before creating a file; never overwrite an existing name.
        library = p.get("greetings")
        if library is not None:
            from .greetings import validate
            validate(library)
            if library.get("personaHash") != digest(content):
                raise ValueError("语库与人格不匹配")
        result = self.sessions.save(p["name"], content, create=True)
        if library is not None:
            self.greetings.set(content, library)
        return {**result, "name": p["name"]}

    def delete_persona(self, p):
        name = p["name"]
        if name == self.config.get("ACTIVE_PERSONA") or any(v.get("persona") == name for v in self.settings.values()):
            raise ValueError("请先切换正在使用此人格的会话")
        file = self.sessions.path(name)
        if file.exists():
            write_text(self.config.data_dir / "config-backups" / f"persona-delete-{uuid.uuid4()}.txt", file.read_text(encoding="utf-8-sig"))
            file.unlink()
        return {"ok": True}

    def activate_persona(self, p):
        return self.sessions.activate(p["name"])

    def export_persona(self, _):
        name = self.config.get("ACTIVE_PERSONA") or "默认人格"
        return {"name": name, "filename": f"Koukou-{name}-人格.txt", "content": self.config.persona()}

    def export_persona_package(self, p):
        name = p.get("name") or self.config.get("ACTIVE_PERSONA") or "默认人格"
        content = persona_text(p.get("content", self.config.persona()))
        bundle = {"format": "koukou-persona", "version": 1, "name": name, "content": content, "greetings": self.greetings.get(content)}
        return {"filename": "Koukou-人格.json", "content": json.dumps(bundle, ensure_ascii=False, indent=2)}

    def get_greetings(self, p):
        return {"library": self.greetings.get(p.get("content", self.config.persona()))}

    def save_greetings(self, p):
        return {"ok": True, "library": self.greetings.set(p["content"], p["library"])}

    def get_poke_replies(self, _):
        file = self.config.data_dir / "poke-replies.txt"
        return {"lines": [x.strip() for x in file.read_text(encoding="utf-8-sig").splitlines() if x.strip() and not x.strip().startswith("#")] if file.exists() else []}

    def save_poke_replies(self, p):
        text = p.get("text")
        if not isinstance(text, str):
            raise ValueError("语库必须是文本")
        lines = [x.strip() for x in text.splitlines() if x.strip() and not x.strip().startswith("#")]
        if not 1 <= len(lines) <= 300 or any(len(x) > 120 or "[CQ:" in x or "\0" in x for x in lines):
            raise ValueError("需要1~300句，每句最多120字纯文字")
        write_text(self.config.data_dir / "poke-replies.txt", "\n".join(lines)+"\n")
        return {"ok": True, "count": len(lines)}

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
        return {"ok": True, "command": self.plugins.set_command(p["id"], p.get("command", ""))}

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
        return self.sessions.set(p["key"], p.get("patch", {}))

    def reset_chat(self, p):
        return self.sessions.set(p["key"], {}, remove=True)

    def memory_update(self, p):
        if p.get("revision") != stamp(self.memory.get(p["key"])):
            raise ValueError("记忆已更新，请刷新后编辑")
        if not isinstance(p.get("content"), str) or not p["content"].strip():
            raise ValueError("记忆内容不能为空")
        self.memory.edit(p["key"], p.get("idx", p.get("index")), p["content"])
        return {"ok": True}

    def memory_delete(self, p):
        if p.get("revision") != stamp(self.memory.get(p["key"])):
            raise ValueError("记忆已更新，请刷新后删除")
        self.memory.edit(p["key"], p.get("idx", p.get("index")), delete=True)
        return {"ok": True}

    def long_update(self, p):
        text = p.get("text", p.get("summary"))
        if not isinstance(text, str):
            raise ValueError("长期记忆需要文本")
        return {"ok": True, **self.long_memory.edit(p["key"], text, paused=True)}

    def pending_delete(self, p):
        record = copy.deepcopy(self.long_memory.record(p["key"]))
        pending = record.get("pending", [])
        index = p.get("index")
        if p.get("revision") != stamp(pending) or not isinstance(index, int) or not 0 <= index < len(pending):
            raise ValueError("待整理原文已更新，请刷新")
        self.long_memory.edit(p["key"], paused=record.get("paused", False))
        pending.pop(index)
        self.long_memory.chats[p["key"]]["pending"] = pending
        self.long_memory.save()
        return {"ok": True}

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
            except RuntimeError as exc:
                return web.json_response({"error": str(exc)}, status=503)

        app = web.Application(client_max_size=16 * 1024 * 1024)
        app.router.add_route("*", "/{path:.*}", dispatch)
        return app
