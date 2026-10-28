"""Explicit parity ledger. A runnable foundation is not an equivalent replacement."""
from pathlib import Path
import json
import ast
from .resources import migration_contract


def implemented_contract():
    """Inspect declared handlers without loading private config or mutable services."""
    module=ast.parse(Path(__file__).with_name('admin.py').read_text(encoding='utf-8-sig'))
    routes,actions=set(),set()
    for node in ast.walk(module):
        if isinstance(node,ast.Assign) and isinstance(node.value,ast.Dict):
            for target in node.targets:
                if isinstance(target,ast.Attribute) and target.attr in {'gets','actions'}:
                    destination=routes if target.attr=='gets' else actions
                    destination.update(key.value for key in node.value.keys if isinstance(key,ast.Constant) and isinstance(key.value,str))
    return routes|{'/api/sticker-file','/api/sticker-blacklist-file'},actions

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
    "src/summaryStats.js": "summary_basics.py + summary_service.py",
    "src/summaryFormat.js": "summary_basics.py",
    "src/summaryContent.js": "summary_basics.py (profile and budgets; reference rendering pending)",
    "src/summaryQuality.js": "summary_quality.py (adds original quote verification)",
    "src/summaryProgress.js": "summary_basics.py",
    "src/dailySummary.js": "summary_history.py + summary_service.py (automatic delivery verification and references pending)",
}
MODULES.update({
    'src/archive.js':'packaging.py + file_commands.py',
    'src/autoPlusOne.js':'messages.py + bot.py',
    'src/chatAppendix.js':'context.py', 'src/chatPrompt.js':'context.py',
    'src/commandCenter.js':'commands.py + custom.py + bot.py + admin.py',
    'src/commandHelp.js':'commands.py', 'src/conversationRules.js':'context.py + prompt_tables.json',
    'src/customCommandSchedule.js':'scheduled.py', 'src/dailyPing.js':'daily_ping.py',
    'src/errorStore.js':'observability.py', 'src/forwardRecords.js':'forward_records.py',
    'src/groupMute.js':'actions.py + duration.py', 'src/humanize.js':'reply_shape.py + rate_limit.py',
    'src/idCheck.js':'id_check.py', 'src/imageCache.js':'image_cache.py',
    'src/imagehash.js':'image_hash.py (optional Pillow; separate versioned dHash cache)',
    'src/imageSearch.js':'image_search.py + http_client.py',
    'src/index.js':'runtime.py + __main__.py (cutover entry acceptance pending)',
    'src/llbotWebui.js':'protocol_management.py', 'src/napcatWebui.js':'protocol_management.py',
    'src/localProfile.js':'vision.py', 'src/logger.js':'observability.py', 'src/metrics.js':'observability.py',
    'src/modelCatalog.js':'providers.py', 'src/muteMath.js':'duration.py',
    'src/notify.js':'observability.py + runtime.py', 'src/onebotErrors.js':'observability.py + onebot.py',
    'src/openPath.js':'lifecycle.py', 'src/permissions.js':'commands.py + actions.py + id_check.py',
    'src/persona.js':'config.py + context.py', 'src/personaStickers.js':'stickers.py',
    'src/pokeReplies.js':'bot.py', 'src/pokeTarget.js':'actions.py',
    'src/qqFace.js':'messages.py + message_tables.json', 'src/questionMode.js':'question_mode.py',
    'src/quietPolicy.js':'messages.py + bot.py + scheduled.py', 'src/quotedMessage.js':'bot.py',
    'src/replyFocus.js':'context.py', 'src/replySanitizer.js':'context.py + models.py',
    'src/replyShape.js':'reply_shape.py', 'src/search.js':'web_search.py',
    'src/selfActions.js':'actions.py', 'src/selfcheck.js':'observability.py',
    'src/stickerLearn.js':'sticker_learn.py', 'src/stickerMetadata.js':'sticker_learn.py',
    'src/stickers.js':'stickers.py', 'src/stickerSend.js':'sticker_policy.py + bot.py',
    'src/summaryFailure.js':'summary_quality.py + summary_service.py',
    'src/summaryJobs.js':'summary_jobs.py + summary_service.py',
    'src/summaryNames.js':'summary_names.py', 'src/summaryReferences.js':'summary_references.py',
    'src/summaryReferenceSelection.js':'summary_references.py',
    'src/summaryRequests.js':'summary_jobs.py + runtime.py', 'src/summarySchedule.js':'summary_schedule.py',
    'src/targetWatch.js':'watch.py', 'src/updateCheck.js':'updates.py',
    'src/visionKnowledge.js':'vision.py', 'src/visionNote.js':'vision.py',
    'src/visionProviders.js':'providers.py', 'src/webSticker.js':'web_sticker.py',
    'src/admin/server.js':'admin.py',
    'src/bot.js':'bot.py + policy.py (integrated native pipeline; end-to-end acceptance pending)',
    'src/quietGreetings.js':'quiet_greetings.py + runtime.py',
    'src/customCommands.js':'custom.py + scheduled.py + bot.py',
    'src/summaryContent.js':'summary_content.py + summary_basics.py',
    'src/dailySummary.js':'summary_history.py + summary_service.py + summary_schedule.py',
})


def report(root, implemented_get=(), implemented_actions=()):
    if not implemented_get and not implemented_actions:
        implemented_get,implemented_actions=implemented_contract()
    source = json.loads(migration_contract(root).read_text(encoding="utf-8-sig"))
    backend = [item for item in source["modules"] if not (item["source"].startswith("src/admin/") and item["source"] != "src/admin/server.js")]
    pending = [item["source"] for item in backend if item["source"] not in MODULES]
    return {"ready": False, "stage": "integration-validation", "baseline": source["baseline"],
            "mappedModules": MODULES, "pendingModules": pending,
            "pendingGetRoutes": sorted(set(source["get"]) - set(implemented_get)),
            "pendingActions": sorted(set(source["actions"]) - set(implemented_actions)),
            'acceptanceGates':['完整功能与控制台契约验收（已有本机HTTP/WS回归）','停写数据快照与恢复（已授权完成全量快照/哈希校验、隔离恢复加载及原JS恢复在线；证明保存在私有操作记录）','生产入口切换（已有显式启动、代际校验的优雅停止和同目录实例锁保护，尚未切换）','Windows/Linux Python 3.11/3.14远程检查','跨协议与权限实机覆盖（已授权NapCat发送/文件/拍一拍/自有消息撤回通过，LLBot及群管理尚未覆盖）'],
            "note": "映射只说明有对应Python实现，不代表全部生产条件已验收。默认run拒绝自动接管，显式原生入口也不代表切换批准；剩余入口与兼容性条件完成前，不能宣布所有部署均可替换。"}
