"""Official QQ SDK bridge adapter, isolated from personal QQ/OneBot identities."""
import asyncio
import base64
import copy
from contextvars import ContextVar
from datetime import datetime
import json
import math
from pathlib import Path
import re
import time
from urllib.parse import urlsplit
from urllib.request import url2pathname

from .onebot import OneBot, OneBotError
from .qq_official_identity import IdentityRegistry, opaque, safe_path, validate_official_profile
from .stickers import image_mime

PROTOCOL = 'koukou-qq-official-v1'
CAPABILITIES = {'text': True, 'image': True, 'ownRecall': True, 'file': False,
                'completeHistory': False, 'members': False, 'moderation': False,
                'poke': False, 'proactive': False}


def bridge_url(config):
    value = config.get('QQ_OFFICIAL_BRIDGE_URL', 'ws://127.0.0.1:8792/bridge')
    parsed = urlsplit(value)
    if (parsed.scheme != 'ws' or parsed.hostname not in {'127.0.0.1', '::1'} or parsed.username
            or parsed.password or parsed.query or parsed.fragment or re.search(r'[\x00-\x20\x7f]', value)):
        raise ValueError('官方桥仅支持固定本机回环ws地址，不能带凭据、查询或远程主机')
    try:
        if not parsed.port or not 1024 <= parsed.port <= 65535:
            raise ValueError
    except ValueError as error:
        raise ValueError('官方桥端口无效') from error
    return value


class OfficialQQ(OneBot):
    def __init__(self, config, session=None, on_event=None):
        token = config.get('KOUKOU_QQ_BRIDGE_TOKEN')
        if len(token) < 32 or re.search(r'[\x00-\x20\x7f]', token):
            raise ValueError('官方桥令牌至少32位，且不能含空白或控制字符')
        url = bridge_url(config)
        validate_official_profile(config)
        super().__init__(url, token, session=None, on_event=on_event)
        self.config, self.registry = config, IdentityRegistry(config)
        self.capabilities = {key: False for key in CAPABILITIES}
        self.binding_state = {'phase': 'unbound'}
        self.sdk_version = ''
        self.latest, self.observed, self.recalled = {}, {}, set()
        self.reply_context = ContextVar('official_reply_context', default=None)
        self.contexts = {}
        self.namespace_error = ''
        if self.registry.app_id:
            self.self_id = self.registry.allocate('bot', self.registry.app_id)

    def unsupported(self, action):
        raise OneBotError('QQ官方实验接入尚不支持此操作：'+action, action=action, code='OFFICIAL_UNSUPPORTED')

    async def _bridge(self, action, params=None, timeout=None):
        return await super().api(action, params, timeout=timeout)

    def identity_rows(self):
        return [{**row, 'alias': row['handle'], 'openId': row['opaqueId'],
                 'scope': 'group' if row['kind'] in {'group', 'group-user'} else 'c2c' if row['kind'] == 'c2c' else 'bot'}
                for row in self.registry.identities()]

    def metadata(self):
        return {'provider': 'qq-official', 'protocol': PROTOCOL, 'appId': self.registry.app_id,
                'capabilities': dict(self.capabilities), 'binding': copy.deepcopy(self.binding_state),
                'identities': self.identity_rows(), 'sdkVersion': self.sdk_version,
                'identityKind': 'application-scoped-openid', 'internalHandlesAreQQNumbers': False,
                'listsAreObservedOnly': True, 'error': self.namespace_error}

    def status(self):
        return {**super().status(), 'provider': 'qq-official', 'appId': self.registry.app_id,
                'capabilities': dict(self.capabilities), 'statusError': self.namespace_error,
                'nickname': 'QQ官方机器人'}

    def invalidate_account(self):
        self.latest.clear()
        self.contexts.clear()
        super().invalidate_account()

    def disconnected(self, owner):
        self.latest.clear()
        self.contexts.clear()
        super().disconnected(owner)

    def _apply_status(self, value):
        if not isinstance(value, dict) or value.get('protocol') != PROTOCOL:
            raise ValueError('官方桥协议不匹配')
        app_id = value.get('appId')
        if not isinstance(app_id, str):
            raise ValueError('官方桥缺少应用身份')
        if app_id:
            self.registry.bind(app_id)
            self.self_id = self.registry.allocate('bot', app_id)
        binding = value.get('binding', {})
        phase = binding.get('phase') if isinstance(binding, dict) else None
        self.binding_state = {'phase': phase if phase in {'unbound', 'preparing', 'qr', 'bound', 'connecting', 'online', 'error', 'canceled'} else 'unbound'}
        qr = binding.get('qrDataUrl') if isinstance(binding, dict) else None
        if isinstance(qr, str) and len(qr) <= 1024*1024 and re.fullmatch(r'data:image/png;base64,[A-Za-z0-9+/=]+', qr):
            try:
                if image_mime(base64.b64decode(qr.split(',', 1)[1], validate=True)) == 'image/png':
                    self.binding_state['qrDataUrl'] = qr
            except ValueError:
                pass
        if isinstance(binding, dict):
            if phase == 'qr' and 'qrDataUrl' in self.binding_state:
                url = binding.get('qrUrl')
                if isinstance(url, str) and len(url) <= 8192:
                    try:
                        parsed = urlsplit(url)
                        if (parsed.scheme == 'https' and parsed.netloc == 'q.qq.com'
                                and parsed.path == '/qqbot/openclaw/connect.html' and not parsed.fragment):
                            self.binding_state['qrUrl'] = url
                    except ValueError:
                        pass
                for field in ('issuedAt', 'refreshAt'):
                    stamp = binding.get(field)
                    if type(stamp) in (int, float) and 0 < stamp < 1e16:
                        self.binding_state[field] = stamp
            message = binding.get('message')
            if isinstance(message, str) and phase == 'error':
                # The bridge publishes fixed user-facing errors, never SDK exception text.
                self.binding_state['message'] = message[:300]
        reported = value.get('capabilities', {})
        self.capabilities = {key: allowed and isinstance(reported, dict) and reported.get(key) is True for key, allowed in CAPABILITIES.items()}
        self.sdk_version = str(value.get('sdkVersion') or '')[:80]
        online = value.get('online') is True and bool(app_id)
        if online and not self.online:
            self.account_version += 1
            self.timeline.begin()
        elif not online and self.online:
            self.invalidate_account()
        self.online = self.probe_verified = online

    def _reject_namespace(self):
        self.namespace_error = '官方桥应用或协议与此独立实例不匹配，连接已停止'
        self.invalidate_account()
        self.stopping = True
        if self.ws and not self.ws.closed:
            task = asyncio.create_task(self.ws.close())
            self.tasks.add(task); task.add_done_callback(self._event_done)

    async def refresh_status(self):
        owner, version = self.ws, self.account_version
        if owner is None:
            return self.status()
        try:
            value = await self._bridge('qq.status')
            if owner is self.ws and version == self.account_version:
                self._apply_status(value)
        except ValueError:
            self._reject_namespace()
        except OneBotError:
            if owner is self.ws:
                self.invalidate_account()
        return self.status()

    @staticmethod
    def _timestamp(value):
        if isinstance(value, str) and not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', value):
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ValueError('官方消息时间必须包含时区')
            value = parsed.timestamp()
        value = float(value)
        if not math.isfinite(value) or value <= 0:
            raise ValueError('官方消息时间无效')
        return value/1000 if value > 10**12 else value

    def _message(self, envelope):
        if not self.online or envelope.get('appId') != self.registry.app_id:
            raise ValueError('官方消息应用身份或在线状态不匹配')
        message = envelope.get('data')
        if not isinstance(message, dict) or message.get('kind') not in {'group', 'c2c'}:
            raise ValueError('官方消息类型无效')
        scope, sender = message['kind'], opaque(message.get('senderId'))
        target = opaque(message.get('groupOpenid')) if scope == 'group' else sender
        mid = opaque(message.get('messageId'))
        at = self._timestamp(message.get('timestamp'))
        target_handle = self.registry.allocate(scope, target)
        sender_handle = self.registry.allocate('group-user', sender, parent=target) if scope == 'group' else target_handle
        context = self.registry.target_context(scope, target)
        handle = self.registry.allocate('incoming-message', mid, parent=context)
        if handle in self.observed:
            return None  # A duplicate must not reset passive quotas or dispatch twice.
        parts = []
        directed = scope == 'group' and message.get('rawEventType') in {'GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE'}
        if directed:
            parts.append({'type': 'at', 'data': {'qq': self.self_id}})
        content = message.get('content', '')
        if not isinstance(content, str):
            raise ValueError('官方消息正文格式无效')
        if content:
            parts.append({'type': 'text', 'data': {'text': content}})
        for attachment in message.get('attachments', []) if isinstance(message.get('attachments', []), list) else []:
            if not isinstance(attachment, dict):
                continue
            mime, url = attachment.get('content_type', attachment.get('contentType', '')), attachment.get('url')
            if isinstance(mime, str) and mime.startswith('image/') and isinstance(url, str) and url.startswith('https://'):
                parts.append({'type': 'image', 'data': {'file': url, 'url': url, 'sub_type': 0}})
        event = {'post_type': 'message', 'message_type': 'group' if scope == 'group' else 'private',
                 'self_id': int(self.self_id), 'user_id': int(sender_handle), 'message_id': int(handle),
                 'time': at, 'message': parts, 'raw_message': content,
                 'sender': {'user_id': int(sender_handle), 'nickname': str(message.get('senderName') or '官方用户')[:100]},
                 '_official_directed': directed,
                 '_official': {'provider': 'qq-official', 'appId': self.registry.app_id, 'scope': scope,
                               'targetId': target, 'senderId': sender, 'messageId': mid}}
        if scope == 'group':
            event['group_id'] = int(target_handle)
        self.timeline.receive(event)
        self.observed[handle] = copy.deepcopy(event)
        while len(self.observed) > 2000:
            self.observed.pop(next(iter(self.observed)))
        if self.timeline.current(event):
            context_value = {'messageId': mid, 'at': at, 'uses': 0, 'session': self.timeline.session}
            self.latest[(scope, target)] = context_value
            self.contexts[(scope, target, mid)] = context_value
            while len(self.contexts) > 2000:
                self.contexts.pop(next(iter(self.contexts)))
        return event

    def receive(self, value, owner):
        if owner is not self.ws or not isinstance(value, dict):
            return
        if 'echo' in value:
            pending = self.pending.get(str(value['echo']))
            if pending and pending[0] is owner and not pending[1].done():
                if value.get('status') == 'ok' and value.get('retcode') == 0:
                    pending[1].set_result(value.get('data'))
                else:
                    code = str(value.get('code') or 'OFFICIAL_BRIDGE_ERROR')
                    pending[1].set_exception(OneBotError('QQ官方桥请求未获确认', code=code[:80], outcome_unknown=value.get('outcomeUnknown') is True))
            return
        try:
            if value.get('type') == 'qq-status':
                self._apply_status(value.get('data'))
                return
            if value.get('type') != 'qq-message':
                return
            event = self._message(value)
            if event is None:
                return
        except (ValueError, TypeError, KeyError):
            if value.get('type') == 'qq-status' or value.get('appId') and value.get('appId') != self.registry.app_id:
                self._reject_namespace()
            return
        if self.on_event:
            async def dispatch():
                source = event['_official']
                token = self.reply_context.set((source['scope'], source['targetId'], source['messageId']))
                try:
                    await self.on_event(event)
                finally:
                    self.reply_context.reset(token)
            task = asyncio.create_task(dispatch()); self.tasks.add(task); task.add_done_callback(self._event_done)

    async def run(self):
        import aiohttp
        # Do not inherit the model session's proxy settings for local credentials.
        async with aiohttp.ClientSession(trust_env=False) as session:
            self.http = session
            try:
                while not self.stopping:
                    owner = None
                    try:
                        async with session.ws_connect(self.url, headers={'Authorization': 'Bearer '+self.token},
                                                      heartbeat=30, max_msg_size=8*1024*1024) as owner:
                            self.ws = owner
                            self.schedule_probe()
                            async for frame in owner:
                                if frame.type == aiohttp.WSMsgType.TEXT:
                                    try: self.receive(json.loads(frame.data), owner)
                                    except (ValueError, TypeError): pass
                                elif frame.type in {aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE}:
                                    break
                    except (OSError, aiohttp.ClientError, TimeoutError):
                        self.log.warning('本机QQ官方桥连接失败，稍后重连')
                    finally:
                        if owner: self.disconnected(owner)
                    if not self.stopping: await asyncio.sleep(3)
            finally:
                self.http = None

    async def binding(self, action):
        if action not in {'start', 'cancel'}:
            raise ValueError('官方绑定操作无效')
        await self._bridge('qq.binding.'+action)
        await self.refresh_status()
        return copy.deepcopy(self.binding_state)

    def _target(self, key):
        if not isinstance(key, str) or not re.fullmatch(r'[gp][0-9]{15}', key):
            raise ValueError('官方会话必须使用已观察到的内部身份')
        scope = 'group' if key.startswith('g') else 'c2c'
        row = self.registry.get(key[1:], {scope})
        return scope, row['opaqueId']

    def _passive(self, scope, target):
        context = self.reply_context.get()
        value = self.contexts.get(context) if context is not None else self.latest.get((scope, target))
        if context is not None and context[:2] != (scope, target):
            self.unsupported('本轮被动回复不能跨会话发送')
        if (not self.online or not value or value['session'] != self.timeline.session
                or not 0 <= time.time()-value['at'] < (300 if scope == 'group' else 1800) or value['uses'] >= 4):
            self.unsupported('无有效被动回复目标（首期不支持主动推送）')
        return value

    def remaining(self, key):
        scope, target = self._target(key)
        return max(0, 4-self._passive(scope, target)['uses'])

    def _image(self, source):
        if not isinstance(source, str):
            raise ValueError('官方图片来源格式无效')
        declared = None
        if source.startswith('data:image/'):
            match = re.fullmatch(r'data:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)', source)
            if not match: raise ValueError('官方图片数据无效')
            declared, encoded = match.groups()
        elif source.startswith('base64://'):
            encoded = source[9:]
        else:
            if source.startswith('file:'):
                url = urlsplit(source)
                if url.netloc not in {'', 'localhost'} or url.query or url.fragment: raise ValueError('官方图片路径无效')
                file = Path(url2pathname(url.path))
            elif source.startswith(('http:', 'https:')):
                raise ValueError('官方发送不读取任意远程图片地址')
            else: file = Path(source)
            file = safe_path(file).resolve()
            roots = [(self.config.data_dir/name).resolve() for name in ('stickers', 'persona-stickers', 'media', 'image-cache')]
            if not any(file.is_relative_to(root) for root in roots) or not file.is_file() or file.stat().st_size > 4*1024*1024:
                raise ValueError('官方图片只允许本实例图片目录内最多4MiB文件')
            encoded = base64.b64encode(file.read_bytes()).decode('ascii')
        if len(encoded) > ((4*1024*1024+2)//3)*4:
            raise ValueError('官方图片不得超过4MiB')
        try: content = base64.b64decode(encoded, validate=True)
        except ValueError as error: raise ValueError('官方图片Base64无效') from error
        mime = image_mime(content)
        if not content or len(content) > 4*1024*1024 or mime is None or declared and declared != mime:
            raise ValueError('官方图片类型、内容或大小无效')
        return {'type': 'image', 'base64': encoded, 'mime': mime}

    async def image_segment(self, file, sticker=False):
        data = self._image(file)
        return {'type': 'image', 'data': {'file': 'data:'+data['mime']+';base64,'+data['base64']}}

    async def send(self, key, message, timeout=None):
        scope, target = self._target(key)
        if isinstance(message, str): message = [{'type': 'text', 'data': {'text': message}}]
        if not isinstance(message, list) or not message: raise ValueError('官方发送内容为空')
        kinds = {part.get('type') for part in message if isinstance(part, dict)}
        if len(kinds) != 1 or len(message) != sum(isinstance(part, dict) for part in message): self.unsupported('混合或未知消息段')
        if kinds == {'text'}:
            if not self.capabilities['text']: self.unsupported('text')
            text = ''.join(str(part.get('data', {}).get('text', '')) for part in message)
            if not text.strip(): raise ValueError('官方文字内容为空')
            segments = [{'type': 'text', 'text': text}]
        elif kinds == {'image'} and len(message) == 1:
            if not self.capabilities['image']: self.unsupported('image')
            segments = [self._image(message[0].get('data', {}).get('file'))]
        else: self.unsupported('消息段类型')
        passive = self._passive(scope, target)
        passive['uses'] += 1  # Reserve before dispatch; an unknown result never frees a slot.
        receipt = await self._bridge('qq.send', {'scope': scope, 'targetId': target, 'msgId': passive['messageId'], 'segments': segments}, timeout=timeout or 30)
        if not isinstance(receipt, dict): raise OneBotError('官方发送回执缺失', outcome_unknown=True)
        try: mid = opaque(receipt.get('messageId'))
        except ValueError as error: raise OneBotError('官方发送未返回真实消息编号', outcome_unknown=True) from error
        try:
            handle = self.registry.allocate('outgoing-message', mid, parent=self.registry.target_context(scope, target))
        except (OSError, ValueError) as error:
            raise OneBotError('官方已返回发送回执，但身份映射未能保存；结果待核验，不会自动重发', outcome_unknown=True) from error
        event = {'message_id': int(handle), 'user_id': int(self.self_id), 'message': copy.deepcopy(message), 'time': time.time(),
                 'sender': {'user_id': int(self.self_id), 'nickname': 'QQ官方机器人'}, 'officialMessageId': mid}
        if scope == 'group': event['group_id'] = int(key[1:])
        else: event['target_id'] = int(key[1:])
        self.observed[handle] = event
        return {'message_id': int(handle), 'officialMessageId': mid, 'provider': 'qq-official'}

    async def member(self, group, user):
        self.unsupported('成员资料与角色')

    async def api(self, action, params=None, timeout=None):
        params = params or {}
        if action == 'get_status': return {'online': self.online, 'good': self.online}
        if action == 'get_login_info': return {'user_id': int(self.self_id) if self.self_id else None, 'nickname': 'QQ官方机器人', 'appId': self.registry.app_id, 'internalHandle': True}
        if action == 'get_version_info': return {'app_name': 'QQOfficialBridge', 'app_version': self.sdk_version, 'protocol_version': PROTOCOL}
        if action in {'get_group_list', 'get_friend_list'}:
            kind = 'group' if action == 'get_group_list' else 'c2c'
            field, label = ('group_id', 'group_name') if kind == 'group' else ('user_id', 'nickname')
            return [{field: int(row['handle']), label: '已观察官方群' if kind == 'group' else '已观察官方私聊',
                     'officialOpenId': row['opaqueId'], 'observedOnly': True, 'internalHandle': True}
                    for row in self.identity_rows() if row['kind'] == kind]
        if action == 'get_msg':
            value = self.observed.get(str(params.get('message_id')))
            if value is None: raise OneBotError('官方消息不在本地已观察缓存中，不能伪造历史', action=action, code='OFFICIAL_NOT_OBSERVED')
            return copy.deepcopy(value)
        if action in {'send_group_msg', 'send_private_msg'}:
            return await self.send(('g' if action == 'send_group_msg' else 'p')+str(params.get('group_id' if action == 'send_group_msg' else 'user_id')), params.get('message'), timeout)
        if action == 'delete_msg':
            if not self.online or not self.capabilities['ownRecall']: self.unsupported('ownRecall')
            row = self.registry.get(params.get('message_id'), {'outgoing-message'})
            if row['handle'] in self.recalled: self.unsupported('已经确认撤回的自发消息')
            scope, target = json.loads(row['parent'])
            result = await self._bridge('qq.recall', {'scope': scope, 'targetId': target, 'messageId': row['opaqueId']}, timeout=timeout or 8)
            self.recalled.add(row['handle'])
            return result
        self.unsupported(action)
