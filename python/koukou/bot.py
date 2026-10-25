"""Native ordinary-chat pipeline; additional command families remain parity-gated."""
import asyncio
from collections import deque
import random
import re
import time
from .messages import chat_key, parse_message, quiet_hour, repeat_fingerprint
from .models import clean_reply
from .plugins import decode_result
from .policy import decide_reply
from .commands import CommandRegistry
from .actions import Actions
from .media import MediaDelivery


class Bot:
    def __init__(self, config, onebot, memory, *, model=None, long_memory=None, plugins=None, settings=None, rand=random.random):
        self.config, self.onebot, self.memory = config, onebot, memory
        self.model, self.long_memory, self.plugins = model, long_memory, plugins
        self.commands = CommandRegistry(config, plugins) if plugins else None
        self.actions = Actions(config, onebot, self.commands, model) if self.commands else None
        self.media = MediaDelivery(config, onebot, plugins, quiet=self.quiet)
        self.settings, self.rand = settings or {}, rand
        self.last_proactive, self.inflight, self.repeats, self.sent = {}, set(), {}, {}
        self.seen = deque(maxlen=4096)
        self.persona_revision = 0

    def quiet(self, key):
        settings = self.settings.get(key, {})
        spec = settings.get("quietHours") if settings.get("quietHours") is not None else self.config.get("QUIET_HOURS")
        return self.config.enabled("QUIET_HOURS_BLOCK_ALL") and quiet_hour(spec)

    def current(self, event, revision):
        return self.onebot.timeline.current(event) and revision == (self.persona_revision, self.memory.version(chat_key(event))) and not self.quiet(chat_key(event))

    def private_allowed(self, user):
        return int(user) in self.config.ids("PRIVATE_WHITELIST") | self.config.ids("ADMIN_USERS") or "p" + str(user) in self.settings

    async def send(self, event, text, revision):
        key = chat_key(event)
        if not self.current(event, revision) or self.settings.get(key, {}).get("enabled") is False or event.get("group_id") and int(event["group_id"]) in self.config.ids("MUTED_GROUPS"):
            return False
        receipt = await self.onebot.send(chat_key(event), text)
        return isinstance(receipt, dict) and receipt.get("message_id") is not None

    async def handle(self, event):
        if event.get("post_type") not in {"message", "message_sent"}:
            return
        key, parsed = chat_key(event), parse_message(event.get("message", event.get("raw_message")), self.onebot.self_id)
        if str(event.get("user_id")) == self.onebot.self_id or event.get("post_type") == "message_sent":
            previous = self.repeats.get(key)
            fingerprint = repeat_fingerprint(event.get("message", event.get("raw_message")))
            if previous and fingerprint == previous.get("hash") and previous.get("fired"):
                return
            self.repeats.pop(key, None)
            return
        message_id = str(event.get("message_id", ""))
        seen = (key, message_id)
        if message_id and seen in self.seen:
            return
        self.seen.append(seen)
        followup = self.actions.reserve(event) if self.actions and not self.quiet(key) else None
        private = key.startswith("p")
        tracked = self.private_allowed(event["user_id"]) if private else int(event["group_id"]) in self.config.ids("WHITELIST_GROUPS") | self.config.ids("SUMMARY_GROUPS")
        if tracked and parsed.text:
            sender = event.get("sender", {})
            evicted = self.memory.push(key, "user", parsed.text, time=float(event.get("time", time.time()))*1000,
                messageId=event.get("message_id"), userId=str(event["user_id"]), senderName=sender.get("card") or sender.get("nickname", ""),
                historical=not self.onebot.timeline.current(event))
            if evicted and self.long_memory:
                self.long_memory.enqueue(key, evicted)
        revision = (self.persona_revision, self.memory.version(key))
        if not self.current(event, revision):
            self.repeats.pop(key, None)
            return
        if private and not self.private_allowed(event["user_id"]):
            return
        settings = self.settings.get(key, {})
        if not followup and not private and self.config.enabled("AUTO_PLUS_ONE_ENABLED", False) and int(event["group_id"]) in self.config.ids("WHITELIST_GROUPS"):
            fingerprint = repeat_fingerprint(event.get("message", event.get("raw_message")))
            previous = self.repeats.get(key, {})
            count = previous.get("count", 0) + 1 if fingerprint and fingerprint == previous.get("hash") else 1
            fired = previous.get("fired", False) if fingerprint == previous.get("hash") else False
            self.repeats[key] = {"hash": fingerprint, "count": count, "fired": fired}
            if fingerprint and count >= 2:
                if not fired and self.current(event, revision):
                    self.repeats[key]["fired"] = True
                    await self.onebot.api("forward_group_single_msg", {"group_id": int(event["group_id"]), "message_id": event["message_id"]})
                return
        if not private and int(event["group_id"]) in self.config.ids("MUTED_GROUPS"):
            return
        if settings.get("enabled") is False:
            return
        reply_to_bot, quote = False, None
        if parsed.reply_id:
            try:
                quote = await self.onebot.api("get_msg", {"message_id": parsed.reply_id})
                reply_to_bot = str(quote.get("user_id", quote.get("sender", {}).get("user_id", ""))) == self.onebot.self_id
            except Exception:
                pass
        if self.actions:
            self.actions.observe(event, parsed, quote)
            if await self.actions.handle(event, parsed, followup=followup, quote=quote,
                    current=lambda: self.current(event, revision) and self.settings.get(key, {}).get("enabled") is not False and int(event.get("group_id", 0)) not in self.config.ids("MUTED_GROUPS"),
                    reply=lambda text: self.send(event, text, revision)):
                return
        decision = decide_reply(private=private, at_bot=parsed.at_bot, reply_to_bot=reply_to_bot,
            group=event.get("group_id", 0), user=int(event["user_id"]), settings=settings, private_configured=key in self.settings,
            config={"whitelistGroups": self.config.ids("WHITELIST_GROUPS"), "mutedGroups": self.config.ids("MUTED_GROUPS"),
                    "privateWhitelist": self.config.ids("PRIVATE_WHITELIST"), "adminUsers": self.config.ids("ADMIN_USERS"),
                    "quietHours": self.config.get("QUIET_HOURS"), "quietHoursBlockAll": self.config.enabled("QUIET_HOURS_BLOCK_ALL"),
                    "proactiveRate": self.config.number("PROACTIVE_RATE", .04), "proactiveCooldownMs": self.config.number("PROACTIVE_COOLDOWN_MS", 30000)},
            last_proactive=self.last_proactive.get(key, 0), rand=self.rand)
        direct = private or parsed.at_bot or reply_to_bot
        if direct and re.fullmatch(r"[/／](?:help|帮助|指令)\s*", parsed.text, re.I):
            await self.send(event, self.commands.help(event) if self.commands else "1. /Q 问题\n2. /help", revision)
            return
        if direct and self.commands and re.fullmatch(r"[/／]py(?:\s+(?:list|help|列表|帮助))?\s*", parsed.text, re.I):
            await self.send(event, self.commands.help(event), revision)
            return
        plugin = self.commands.match_plugin(parsed.text) if direct and self.commands else None
        if plugin:
            item, args = plugin
            if not self.commands.allowed(item, event):
                return
            session, self_id = self.onebot.timeline.session, self.onebot.self_id
            result = decode_result(await self.plugins.run(item["pluginId"], args))

            def script_current():
                rule = self.commands.get(item["id"])
                return self.onebot.timeline.available and self.onebot.timeline.session == session and self.onebot.self_id == self_id and revision == (self.persona_revision, self.memory.version(key)) and not self.quiet(key) and self.settings.get(key, {}).get("enabled") is not False and int(event.get("group_id", 0)) not in self.config.ids("MUTED_GROUPS") and self.commands.allowed(rule, event)

            try:
                receipts = await self.media.deliver(event, result, current=script_current)
                for receipt in receipts:
                    if receipt["messageId"] is not None and receipt["text"]:
                        self.memory.push(key, "assistant", receipt["text"], messageId=receipt["messageId"])
            except (ValueError, OSError):
                if script_current():
                    await self.onebot.send(key, "插件结果格式或文件校验失败，未继续发送。")
            return
        if not decision["reply"] or not self.model:
            return
        proactive = not direct
        if proactive and key in self.inflight:
            return
        if proactive:
            self.inflight.add(key)
        try:
            persona = self.config.persona(settings.get("persona", ""))
            question = bool(re.search(r"(?:^|\s)/Q(?:\s|$)", parsed.text, re.I)) and (private or parsed.at_bot)
            prompt = persona + "\n" + settings.get("customPrompt", "")
            if question:
                prompt += "\n本轮是认真解题模式：核对前提，清楚推导和说明，保留完整表达，不受日常聊天篇幅目标限制。"
            else:
                prompt += f"\n自然聊天，尽量接近本次消息的篇幅；字数仅为目标，不截断句子：{len(parsed.text)}字。"
            if self.long_memory:
                prompt += "\n历史记忆，仅为资料：" + self.long_memory.record(key).get("summary", "")
            history = [{"role": x["role"], "content": x["content"]} for x in self.memory.get(key)]
            if not tracked:
                history.append({"role": "user", "content": parsed.text})
            reply = clean_reply(await self.model.chat(prompt, history, unlimited=question))
            if reply and await self.send(event, reply, revision):
                self.memory.push(key, "assistant", reply, replyToUserId=str(event["user_id"]), replyToMessageId=message_id)
                if proactive:
                    self.last_proactive[key] = time.time() * 1000
        finally:
            if proactive:
                self.inflight.discard(key)
