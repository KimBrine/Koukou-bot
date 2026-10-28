"""Direct Python translation of the ordinary reply decision boundary."""
import random
from datetime import datetime, timezone
from .messages import quiet_hour


def decide_reply(*, private, at_bot, reply_to_bot=False, group=0, config=None, settings=None,
                 private_configured=False, user=0, last_proactive=0, now=None, rand=random.random):
    config, settings = config or {}, settings or {}
    now = datetime.now().timestamp() if now is None else now
    no = lambda reason: {"reply": False, "reason": reason}
    yes = lambda reason: {"reply": True, "reason": reason}
    if settings.get("enabled") is False:
        return no("本会话已关闭")
    if not private and int(group) in config.get("mutedGroups", []):
        return no("该群已静音（MUTED_GROUPS）")
    spec = settings.get("quietHours") if settings.get("quietHours") is not None else config.get("quietHours", "")
    quiet = quiet_hour(spec, datetime.fromtimestamp(now, timezone.utc))
    if config.get("quietHoursBlockAll") is not False and quiet:
        return no("安静时段（全部静音）")
    if private:
        if settings.get("atReplyEnabled") is False:
            return no("本会话已关闭回复")
        if "privateWhitelist" in config and user not in config["privateWhitelist"] and user not in config.get("adminUsers", []) and not private_configured:
            return no("私聊不在白名单")
        return yes("私聊消息")
    if at_bot or reply_to_bot:
        if settings.get("atReplyEnabled") is False:
            return no("本会话已关闭@/引用回复")
        return yes("群内被@" if at_bot else "群内被引用")
    if group not in config.get("whitelistGroups", []):
        return no("非白名单群且未被@")
    if settings.get("proactiveEnabled") is False:
        return no("本会话已关闭主动搭话")
    if quiet:
        return no("安静时段（只回 @）")
    rate = settings.get("proactiveRate") if settings.get("proactiveRate") is not None else config.get("proactiveRate", .04)
    if rand() < rate:
        if config.get("proactiveCooldownMs", 30000) > 0 and now * 1000 - last_proactive < config.get("proactiveCooldownMs", 30000):
            return no("主动搭话冷却中")
        return yes("白名单群主动搭话")
    return no("白名单群未抽中")
