"""Native asyncio OneBot 11 client. Outgoing actions are never automatically retried."""
import asyncio
import json
import logging
import re
import time
import uuid
from .messages import Timeline


def confirmed_message_id(receipt):
    value = str(receipt.get('message_id', '')) if isinstance(receipt, dict) else ''
    return value if re.fullmatch(r'-?\d+', value) and int(value) != 0 else None


class OneBotError(RuntimeError):
    def __init__(self, message, *, action="", outcome_unknown=False, code="ONEBOT_ERROR"):
        super().__init__(message)
        self.action, self.outcome_unknown, self.code = action, outcome_unknown, code


class OneBot:
    def __init__(self, url, token="", session=None, on_event=None):
        self.url, self.token, self.http = url, token, session
        self.on_event = on_event
        self.ws = None
        self.self_id = ""
        self.timeline = Timeline()
        self.pending, self.tasks = {}, set()
        self.stopping, self.online, self.probe_verified = False, False, False
        self.account_version = 0
        self.probe_task = None
        self.image_style = None
        self.log = logging.getLogger("koukou.onebot")

    async def api(self, action, params=None, timeout=None):
        owner = self.ws
        if owner is None or owner.closed:
            raise OneBotError("OneBot未连接", action=action)
        timeout = timeout if timeout is not None else 30 if action.startswith("send_") else 600 if action.startswith("upload_") else 8
        echo = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[echo] = (owner, future)
        dispatched = False
        try:
            await owner.send_json({"action": action, "params": params or {}, "echo": echo})
            dispatched = True
            try:
                return await asyncio.wait_for(asyncio.shield(future), timeout or None)
            except TimeoutError as exc:
                raise OneBotError(f"OneBot API超时：{action}", action=action, outcome_unknown=True, code="ONEBOT_TIMEOUT") from exc
        except asyncio.CancelledError:
            raise
        except OneBotError:
            raise
        except Exception as exc:
            raise OneBotError(f"OneBot请求失败：{action}", action=action, outcome_unknown=dispatched) from exc
        finally:
            self.pending.pop(echo, None)
            if not future.done():
                future.cancel()

    def receive(self, data, owner):
        if owner is not self.ws:
            return
        if "echo" in data:
            pending = self.pending.get(str(data["echo"]))
            if pending and pending[0] is owner and not pending[1].done():
                future = pending[1]
                if data.get("status") in {"ok", "async"} and data.get("retcode", 0) == 0:
                    future.set_result(data.get("data"))
                else:
                    future.set_exception(OneBotError(str(data.get("message") or data.get("wording") or "QQ操作失败")))
            return
        if data.get("self_id"):
            id = str(data["self_id"])
            if self.self_id and self.self_id != id:
                self.invalidate_account()
                self.schedule_probe()
            self.self_id = id
        if data.get("post_type") == "meta_event" and data.get("meta_event_type") == "heartbeat":
            if data.get("status", {}).get("online") is False:
                self.invalidate_account()
            elif not self.probe_verified:
                self.schedule_probe()
        if data.get("post_type") in {"message", "message_sent", "notice"}:
            self.timeline.receive(data)
        if self.on_event:
            task = asyncio.create_task(self.on_event(data))
            self.tasks.add(task)
            task.add_done_callback(self._event_done)

    def _event_done(self, task):
        self.tasks.discard(task)
        if not task.cancelled() and task.exception():
            self.log.error("事件处理失败：%s", str(task.exception()))

    def invalidate_account(self):
        self.account_version += 1
        self.online, self.probe_verified = False, False
        self.timeline.end()
        for owner, future in list(self.pending.values()):
            if not future.done():
                future.set_exception(OneBotError("QQ账号或登录态变化，操作结果未知", outcome_unknown=True))

    def schedule_probe(self):
        if self.probe_task and not self.probe_task.done():
            return
        self.probe_task = asyncio.create_task(self.refresh_status())
        self.tasks.add(self.probe_task)
        self.probe_task.add_done_callback(self._event_done)

    def disconnected(self, owner):
        if owner is self.ws:
            self.timeline.end()
            self.ws, self.online, self.probe_verified = None, False, False
            self.image_style = None
        for echo, (ws, future) in list(self.pending.items()):
            if ws is owner and not future.done():
                future.set_exception(OneBotError("OneBot连接中断，结果未知", outcome_unknown=True))

    async def refresh_status(self):
        owner = self.ws
        version = self.account_version
        if owner is None:
            return self.status()
        try:
            reported = await self.api("get_status")
            info = await self.api("get_login_info")
            if reported.get("online") is True and info.get("user_id"):
                await self.api("get_group_list")
                if self.ws is owner and version == self.account_version:
                    changed = not self.online or self.self_id != str(info["user_id"])
                    self.self_id = str(info["user_id"])
                    self.online, self.probe_verified = True, True
                    if changed:
                        self.account_version += 1
                        self.timeline.begin()
            else:
                if self.ws is owner and version == self.account_version:
                    self.invalidate_account()
        except OneBotError:
            if self.ws is owner and version == self.account_version:
                self.invalidate_account()
        return self.status()

    def status(self):
        return {"connected": self.ws is not None and not self.ws.closed, "online": self.online,
                "probeVerified": self.probe_verified, "selfId": self.self_id, "accountVersion": self.account_version}

    async def run(self):
        import aiohttp
        own_session = self.http is None
        if own_session:
            self.http = aiohttp.ClientSession()
        try:
            while not self.stopping:
                owner = None
                try:
                    headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
                    async with self.http.ws_connect(self.url, headers=headers, heartbeat=30, max_msg_size=8*1024*1024) as owner:
                        self.ws = owner
                        self.timeline.begin()
                        self.schedule_probe()
                        async for frame in owner:
                            if frame.type == aiohttp.WSMsgType.TEXT:
                                try:
                                    self.receive(json.loads(frame.data), owner)
                                except (ValueError, TypeError):
                                    self.log.warning("忽略无效OneBot消息")
                            elif frame.type in {aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE}:
                                break
                except (OSError, aiohttp.ClientError, TimeoutError):
                    self.log.warning("OneBot连接失败，稍后重连")
                finally:
                    if owner:
                        self.disconnected(owner)
                if not self.stopping:
                    await asyncio.sleep(3)
        finally:
            if own_session:
                await self.http.close()

    async def close(self):
        self.stopping = True
        owner = self.ws
        if owner:
            await owner.close()
            self.disconnected(owner)
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def send(self, key, message, timeout=None):
        action = "send_group_msg" if key.startswith("g") else "send_private_msg"
        field = "group_id" if key.startswith("g") else "user_id"
        if isinstance(message, str):
            message = [{"type": "text", "data": {"text": message}}]
        return await self.api(action, {field: int(key[1:]), "message": message}, timeout=timeout)

    async def member(self, group, user):
        return await self.api("get_group_member_info", {"group_id": int(group), "user_id": int(user), "no_cache": True})

    async def image_segment(self, file, sticker=False):
        if isinstance(file, str) and file.startswith('data:image/') and ';base64,' in file:
            file = 'base64://'+file.split(';base64,', 1)[1]
        data = {'file': file}
        if sticker:
            if self.image_style is None:
                try:
                    version = await self.api('get_version_info')
                    identity = json.dumps(version, ensure_ascii=False)
                    self.image_style = 'camel' if re.search('LLOneBot|LLBot', identity, re.I) else 'snake' if re.search('NapCat', identity, re.I) else 'both'
                except OneBotError:
                    self.image_style = 'both'
            if self.image_style != 'snake':
                data['subType'] = 1
            if self.image_style != 'camel':
                data['sub_type'] = 1
        return {'type': 'image', 'data': data}
