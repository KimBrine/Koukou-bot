"""Explicit parity ledger. A runnable foundation is not an equivalent replacement."""
from pathlib import Path
import json

MODULES = {
    "src/stateFile.js": "state.py", "src/config.js": "config.py", "src/onebot.js": "onebot.py",
    "src/messageFreshness.js": "messages.py", "src/cq.js": "messages.py",
    "src/pythonPlugins.js": "plugins.py", "src/deepseek.js": "models.py",
    "src/memory.js": "memory.py", "src/longMemory.js": "memory.py",
    "src/bot.js": "bot.py + policy.py (ordinary chat only; command families pending)",
    "src/chatSettings.js": "sessions.py + admin.py",
    "src/conversationSessions.js": "sessions.py",
    "src/personaSwitch.js": "sessions.py",
    "src/memoryArchive.js": "archive.py",
    "src/personaGreetings.js": "greetings.py",
    "src/quietGreetings.js": "quiet_greetings.py (scheduler implemented; runtime startup integration pending)",
    "src/backup.js": "backup.py",
    "src/customCommands.js": "custom.py + bot.py (persistent scheduled delivery pending)",
    "src/music.js": "music.py",
}


def report(root, implemented_get=(), implemented_actions=()):
    source = json.loads((Path(root) / "python" / "migration-contract.json").read_text(encoding="utf-8-sig"))
    backend = [item for item in source["modules"] if not (item["source"].startswith("src/admin/") and item["source"] != "src/admin/server.js")]
    pending = [item["source"] for item in backend if item["source"] not in MODULES]
    return {"ready": False, "stage": "native-foundation", "baseline": source["baseline"],
            "mappedModules": MODULES, "pendingModules": pending,
            "pendingGetRoutes": sorted(set(source["get"]) - set(implemented_get)),
            "pendingActions": sorted(set(source["actions"]) - set(implemented_actions)),
            "note": "映射只说明有对应Python实现，不代表完整行为已验收。必须完成全部后端模块、接口契约和现有行为回归后，才能宣布可替换生产实例；当前禁止连接QQ。"}
