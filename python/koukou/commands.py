"""One slash-command namespace shared by native builtins and Python plugins."""
import re
import unicodedata
from .state import read_json, write_json

RESERVED = {"q", "help", "帮助", "指令", "命令", "py", "群总结", "群聊总结", "今日总结", "每日总结",
            "清除记忆", "清空记忆", "重置记忆", "id_check", "id_check_kick", "发文件", "发链接", "点歌"}
BUILTINS = [
    ("help", "指令帮助", "/help", "none"), ("question", "认真解题", "/Q 问题", "required"),
    ("owner-mute", "群管理禁言/解禁", "@机器人 禁言/解禁 指定成员 时长", "required"),
    ("self-mute", "自助禁言", "@机器人 禁言我 时长", "required"),
    ("whole-mute", "全员禁言", "@机器人 开启/关闭全员禁言", "required"),
    ("self-recall", "帮忙撤回", "引用消息并@机器人 帮忙撤回", "required"),
    ("request-poke", "请求拍一拍", "@机器人 拍一拍 指定成员", "required"),
    ("poke", "拍机器人回应", "拍机器人头像", "none"),
    ("music", "点歌音乐名片", "点歌 歌名 歌手 / 歌曲ID / 完整歌曲链接", "required"),
]
MANAGEMENT = {"owner-mute", "self-mute", "whole-mute", "self-recall"}


def normalize(name):
    return unicodedata.normalize("NFKC", str(name)).casefold()


def split_request(text):
    match = re.fullmatch(r"\s*[/／]([^\s/／]+)(?:\s+([\s\S]*))?", str(text))
    return (normalize(match[1]), match[2] or "") if match else None


class CommandRegistry:
    def __init__(self, config, plugins):
        self.config, self.plugins = config, plugins
        self.file = config.data_dir / "command-center.json"

    def custom(self):
        items = read_json(self.config.data_dir / "custom-commands.json", [])
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise ValueError("自定义指令格式损坏，拒绝注册冲突的插件")
        return items

    def state(self):
        data = read_json(self.file, {"version": 1, "builtins": {}})
        if not isinstance(data, dict) or not isinstance(data.get("builtins", {}), dict):
            raise ValueError("指令权限设置格式错误")
        return data

    def reserved(self):
        names = set(RESERVED)
        for item in self.custom():
            for trigger in [item.get("trigger", ""), *item.get("aliases", [])]:
                match = split_request(trigger)
                if match:
                    names.add(match[0])
        return names

    def validate_name(self, name, owner):
        if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]{1,40}", name):
            raise ValueError("指令名只能包含中英文、数字、下划线、短横线")
        key = normalize(name)
        if key in self.reserved():
            raise ValueError("指令名与内置或自定义指令冲突")
        for item in self.plugins.list():
            if item["id"] != owner and key in {normalize(item["id"]), normalize(item["command"])}:
                raise ValueError("指令名与另一插件冲突")

    def plugin_entries(self):
        items, state = self.plugins.list(), self.state()
        overrides = state.get("builtins", {})
        global_rule = overrides.get("python", {})
        reserved, index, result = self.reserved(), {}, []
        for item in items:
            for name in {normalize(item["id"]), normalize(item["command"])}:
                index.setdefault(name, set()).add(item["id"])
        for item in items:
            names = {normalize(item["id"]), normalize(item["command"])}
            conflict = bool(names & reserved or any(len(index[name]) > 1 for name in names))
            override = overrides.get("plugin:" + item["id"], {})
            command = item["command"]
            usage = re.sub(r"[/／]py\s+\S+", lambda _: "/" + command, item.get("usage", ""), flags=re.I)
            usage = usage or f"/{command} [参数]"
            result.append({"id": "plugin:" + item["id"], "pluginId": item["id"], "source": "python-plugin",
                "name": item["name"], "command": command, "trigger": f"/{command} [参数]", "usage": usage,
                "aliases": ["/" + item["id"]] if command != item["id"] else [],
                "description": item["description"] + ("（指令名冲突，请修改调用名）" if conflict else ""),
                "enabled": item["enabled"] and override.get("enabled", True) is not False and global_rule.get("enabled", True) is not False and not conflict,
                "adminOnly": bool(item["admin"] or override.get("adminOnly", global_rule.get("adminOnly", True)) is not False),
                "protected": item["admin"], "scope": override.get("scope", global_rule.get("scope", "all")),
                "groups": override.get("groups", global_rule.get("groups", [])), "ai": "none", "responseMode": "fixed",
                "naturalLanguage": False, "conflict": conflict})
        return result

    def all(self):
        settings = self.state().get("builtins", {})
        items = []
        for id, name, trigger, ai in BUILTINS:
            item = {"id": id, "name": name, "trigger": trigger, "ai": ai, "enabled": id in {"help", "question", "music"} or id == "poke" and self.config.enabled("POKE_REPLY_ENABLED"),
                    "scope": "group" if id in MANAGEMENT else "groups" if id == "request-poke" else "all",
                    "groups": [], "adminOnly": False, "description": name, "management": id in MANAGEMENT,
                    "whitelistOnly": id == "request-poke", "responseMode": "fixed", **settings.get(id, {})}
            # Permission category is an implementation property, never imported from configuration.
            item.update(id=id, management=id in MANAGEMENT, whitelistOnly=id == "request-poke")
            items.append(item)
        return [*items, *self.plugin_entries()]

    def get(self, id):
        return next((item for item in self.all() if item["id"] == id), None)

    def save_builtin(self, payload):
        if str(payload.get("id", "")).startswith("plugin:"):
            return self.save_plugin(payload)
        item = self.get(payload.get("id"))
        if not item:
            raise ValueError("未知内置指令")
        scope = payload.get("scope", item["scope"])
        if scope not in {"all", "group", "groups", "private"}:
            raise ValueError("适用范围无效")
        if item["id"] in MANAGEMENT and scope != "group":
            raise ValueError("管理与撤回指令必须指定群聊")
        groups = payload.get("groups", item["groups"])
        if not isinstance(groups, list) or any(not str(g).isdecimal() or int(g) <= 0 for g in groups):
            raise ValueError("群号无效")
        enabled = payload.get("enabled", item["enabled"]) is True
        if enabled and scope == "group" and not groups:
            raise ValueError("请指定适用群")
        state = self.state()
        state.setdefault("builtins", {})[item["id"]] = {"enabled": enabled, "scope": "groups" if item["whitelistOnly"] else scope,
            "groups": [] if item["whitelistOnly"] else sorted(set(map(int, groups))), "adminOnly": False if item["whitelistOnly"] else payload.get("adminOnly", item["adminOnly"]) is True,
            "responseMode": "ai" if item["id"] == "poke" and payload.get("responseMode") == "ai" else "fixed"}
        write_json(self.file, state)
        return self.get(item["id"])

    def match_plugin(self, text):
        request = split_request(text)
        if not request:
            return None
        name, args = request
        if name == "py":
            parts = args.split(None, 1)
            if not parts or parts[0].lower() in {"list", "help", "列表", "帮助"}:
                return None
            name, args = normalize(parts[0]), parts[1] if len(parts) > 1 else ""
        if name in self.reserved():
            return None
        matches = [item for item in self.plugin_entries() if name in {normalize(item["command"]), normalize(item["pluginId"])}]
        # Ambiguous entries are disabled by plugin_entries; consume instead of falling through to AI.
        return (matches[0], args) if matches else None

    def allowed(self, item, event):
        if not item or not item["enabled"]:
            return False
        private = not event.get("group_id")
        scope = item.get("scope", "all")
        if scope not in {"all", "private", "group", "groups"}:
            return False
        if item.get("management") and scope != "group":
            return False
        if item.get("whitelistOnly") and (private or int(event["group_id"]) not in self.config.ids("WHITELIST_GROUPS")):
            return False
        if private and scope in {"group", "groups"} or not private and scope == "private":
            return False
        if scope == "group" and int(event.get("group_id", 0)) not in {int(g) for g in item.get("groups", [])}:
            return False
        return not item["adminOnly"] or int(event["user_id"]) in self.config.ids("ADMIN_USERS")

    def save_plugin(self, payload):
        item = next((item for item in self.plugin_entries() if item["id"] == payload.get("id")), None)
        if not item:
            raise ValueError("不是已注册的插件指令")
        scope = payload.get("scope", item["scope"])
        if scope not in {"all", "private", "group", "groups"}:
            raise ValueError("适用范围无效")
        groups = payload.get("groups", item["groups"])
        if not isinstance(groups, list) or any(not str(g).isdecimal() or int(g) <= 0 for g in groups):
            raise ValueError("群号无效")
        if scope == "group" and not groups:
            raise ValueError("请选择适用群")
        state = self.state()
        state.setdefault("builtins", {})[item["id"]] = {"enabled": payload.get("enabled", item["enabled"]) is True,
            "adminOnly": bool(item["protected"] or payload.get("adminOnly", item["adminOnly"])), "scope": scope, "groups": sorted(set(map(int, groups)))}
        write_json(self.file, state)
        if "enabled" in payload:
            self.plugins.set_enabled(item["pluginId"], payload["enabled"] is True)
        return next(value for value in self.plugin_entries() if value["id"] == item["id"])

    def help(self, event):
        items = [item for item in [*self.all(), *self.custom()] if self.allowed(item, event)]
        return "📋 当前会话的指令\n\n" + "\n\n".join(f"{index}. {item['trigger']}\n   {item['name']}" for index, item in enumerate(items, 1)) + "\n\n群聊请@机器人；调用权限与寂静时段规则仍然生效。"
