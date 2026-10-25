"""Exact name checks and a separately confirmed, single-use removal workflow."""
import asyncio
import copy
import math
import re
import time
import uuid

from .state import read_json, write_json
from .onebot import confirmed_message_id

ROOM_RE = re.compile(r'^(?:[6-9][0-9]{1,2}|10[0-9]{1,2})(?![0-9])')
BOT_NAME_RE = re.compile(r'(群管家|群助手|群机器人|^【(?:店员|客服|官方|助手|系统|机器人)】|(?:机器人|小助手)$)')
ID_CHECK_CMD_RE = re.compile(r'^[\/／]?\s*(?:id[_\s-]?check|查名片|名片核对|名字核对)\s*[。！!~～.…]*$', re.I)
ID_CHECK_KICK_CMD_RE = re.compile(r'^[\/／]?\s*(?:id[_\s-]?check[_\s-]?kick|核对踢人|查名片踢人|名字核对踢人)\s*[。！!~～.…]*$', re.I)
KICK_WINDOW_MS = 300000


def text(value):
    return '' if value is None else str(value)


def to_half_width_digits(value):
    return text(value).translate(str.maketrans('０１２３４５６７８９', '0123456789'))


def display_name(member):
    return text((member or {}).get('card')).strip() or text((member or {}).get('nickname')).strip()


def check_name(raw):
    name = to_half_width_digits(raw).strip()
    if not name:
        return {'ok': False, 'reason': '没有群名片'}
    match = ROOM_RE.match(name)
    if match:
        return {'ok': True, 'room': match[0]}
    number = re.match(r'^([0-9]+)', name)
    if not number:
        return {'ok': False, 'reason': '名字前面没有房间号'}
    value = number[0]
    floor = int(value[0]) if len(value) == 3 else int(value[:2]) if len(value) == 4 and value[0] == '1' else None
    if floor is not None and not 6 <= floor <= 10:
        return {'ok': False, 'reason': f'楼层 {floor} 不在 6~10 层范围内'}
    return {'ok': False, 'reason': '房间号格式不对（形如 604 或 1009）'}


def likely_bot(member, bot_name_re=BOT_NAME_RE):
    return (member or {}).get('is_robot') is True or bool(bot_name_re and bot_name_re.search(display_name(member)))


def check_members(members, *, self_id='', skip=(), skip_bots=True, bot_name_re=BOT_NAME_RE):
    own, skip = text(self_id), {text(value) for value in skip if text(value)}
    result = {'total': 0, 'ok': [], 'bad': [], 'skipped': []}
    for member in members if isinstance(members, list) else []:
        member = member or {}
        user = text(member.get('user_id'))
        if not user:
            continue
        name = display_name(member)
        why = ('机器人自己' if own and user == own else 'ID_CHECK_SKIP 指定跳过' if user in skip else
               ('QQ 机器人账号' if member.get('is_robot') is True else '名字像服务账号') if skip_bots and likely_bot(member, bot_name_re) else '')
        if why:
            result['skipped'].append({'userId': user, 'name': name, 'why': why})
            continue
        checked = check_name(name)
        if checked['ok']:
            result['ok'].append({'userId': user, 'name': name, 'room': checked['room']})
        else:
            result['bad'].append({'userId': user, 'name': name, 'reason': checked['reason'], 'role': member.get('role') or 'member'})
    result['total'] = len(result['ok'])+len(result['bad'])
    return result


def build_reminder_messages(bad, *, reminder='以上群友记得改名哦~', per_message=0):
    if not isinstance(bad, list) or not bad:
        return []
    size = max(0, math.floor(float(per_message or 0))) or len(bad)
    messages = []
    for start in range(0, len(bad), size):
        segments = []
        for person in bad[start:start+size]:
            segments.extend([{'type': 'at', 'data': {'qq': person['userId']}}, {'type': 'text', 'data': {'text': '\n'}}])
        if start+size >= len(bad):
            segments.append({'type': 'text', 'data': {'text': reminder}})
        messages.append(segments)
    return messages


def can_run_id_check(user_id, operators=()):
    values = [text(value).strip() for value in operators if text(value).strip()] if isinstance(operators, (list, tuple, set)) else []
    return not values or text(user_id).strip() in values


def can_kick_now(*, record, group_id, user_id, operators=(), now=None, is_bot_admin=False, window_ms=KICK_WINDOW_MS):
    now = time.time()*1000 if now is None else now
    allowed = [text(value).strip() for value in operators if text(value).strip()] if isinstance(operators, (list, tuple, set)) else []
    no = lambda reason: {'ok': False, 'reason': reason}
    if not allowed:
        return no('未配置 ID_CHECK_OPERATORS，踢人已禁用')
    if text(user_id).strip() not in allowed:
        return no(f'QQ {user_id} 不在授权名单里')
    if not is_bot_admin:
        return no('机器人不是管理员/群主，没有踢人权限')
    if not record:
        return no('还没有跑过 /id_check（或结果已被清理）')
    if text(record.get('group_id')) != text(group_id):
        return no(f"上次核对的是别的群（{record.get('group_id')}）")
    try:
        age = float(now)-float(record.get('at') or 0)
    except (ValueError, TypeError, OverflowError):
        age = float('nan')
    if not math.isfinite(age) or age < 0 or age > window_ms:
        rounded = str(math.floor(age/1000+.5)) if math.isfinite(age) else 'NaN'
        return no(f'上次核对已过期（{rounded}s 前，上限 {math.floor(window_ms/1000+.5)}s）')
    if record.get('kicked'):
        return no('这次核对的结果已经用来踢过人了（一次核对只能踢一次）')
    people = record.get('bad') if isinstance(record.get('bad'), list) else []
    return {'ok': True, 'reason': f'可以踢：{len(people)} 人', 'list': people} if people else no('上次核对没有不合格的人')


class IdCheck:
    """Native protocol adapter. Invalid gates return silently with structured proof.

    inspect() never arms a removal. run_check() establishes the independent human
    confirmation window; run_kick() consumes it durably before any mutation. An
    unconfirmed removal is never retried, including after process restart.
    """
    def __init__(self, config, onebot, registry=None, *, can_send=lambda key: True, now=lambda: time.time()*1000, pause=asyncio.sleep):
        self.config, self.onebot, self.registry = config, onebot, registry
        self.can_send, self.now, self.pause = can_send, now, pause
        self.file = config.data_dir / 'native-id-check.json'
        self.state = read_json(self.file, {'version': 1, 'records': {}, 'checks': {}})
        if not isinstance(self.state, dict) or self.state.get('version') != 1 or not all(isinstance(self.state.get(key), dict) for key in ('records', 'checks')):
            raise ValueError('名片核对操作记录损坏，已停用以免重复移出成员')
        for group, record in self.state['records'].items():
            if not str(group).isdigit() or not isinstance(record, dict) or not isinstance(record.get('bad'), list):
                raise ValueError('名片核对快照损坏')
        self.runtime_token, self.locks = uuid.uuid4().hex, {}

    def save(self):
        write_json(self.file, self.state)

    def token(self):
        return (self.onebot.timeline.session, getattr(self.onebot, 'account_version', 0), text(self.onebot.self_id))

    def allowed(self, feature, event):
        if not event.get('group_id') or not self.can_send('g'+text(event['group_id'])):
            return False
        if self.registry is not None:
            item = self.registry.get(feature)
            return bool(item and self.registry.allowed(item, event))
        groups = self.config.ids('ID_CHECK_GROUPS')
        return (self.config.enabled('ID_CHECK_KICK_ENABLED' if feature.endswith('kick') else 'ID_CHECK_ENABLED')
                and (not groups or int(event['group_id']) in groups))

    def policy(self, feature):
        return copy.deepcopy(self.registry.get(feature)) if self.registry else None

    async def inspect(self, group):
        group = int(group)
        if group <= 0:
            raise ValueError('群号无效')
        token = self.token()
        raw = await self.onebot.api('get_group_member_list', {'group_id': group, 'no_cache': True})
        members = raw if isinstance(raw, list) else raw.get('data') if isinstance(raw, dict) else None
        if not isinstance(members, list) or any(not isinstance(member, dict) or not re.fullmatch(r'[0-9]+', text(member.get('user_id'))) for member in members):
            raise ValueError('群成员名单格式无效，未建立移出名单')
        if token != self.token():
            raise ValueError('读取群成员期间连接变化')
        # Refuse conflicting roster identities rather than act on an arbitrary row.
        unique = {}
        for member in members:
            user = text(member['user_id'])
            if user in unique and unique[user] != member:
                raise ValueError('群成员名单存在身份冲突')
            unique[user] = member
        result = check_members(list(unique.values()), self_id=self.onebot.self_id,
            skip=self.config.ids('ID_CHECK_SKIP'), skip_bots=self.config.enabled('ID_CHECK_SKIP_BOTS'))
        return {**result, 'raw': len(members)}

    async def run_check(self, event, *, current=lambda: True):
        group = text(event.get('group_id'))
        lock = self.locks.setdefault(group, asyncio.Lock())
        async with lock:
            policy, token = self.policy('id-check'), self.token()
            active = lambda: current() and token == self.token() and self.allowed('id-check', event) and policy == self.policy('id-check')
            operator = can_run_id_check(event.get('user_id'), self.config.ids('ID_CHECK_OPERATORS')) or int(event.get('user_id') or 0) in self.config.ids('ADMIN_USERS')
            if not active() or not operator:
                return {'ok': False, 'silent': True}
            request = f"{self.onebot.self_id}:{group}:{event.get('message_id', uuid.uuid4().hex)}"
            if request in self.state['checks']:
                return {'ok': False, 'duplicate': True, 'silent': True}
            result = await self.inspect(group)
            if not active() or not result['total']:
                return {**result, 'qualified': result['ok'], 'ok': False, 'silent': True}
            self.state['records'][group] = {'group_id': int(group), 'at': self.now(), 'bad': result['bad'], 'kicked': False,
                'selfId': text(self.onebot.self_id), 'runtimeToken': self.runtime_token, 'connection': list(token), 'steps': {}}
            delivery = self.state['checks'][request] = {'status': 'reserved', 'at': self.now(), 'steps': {}}
            self.save()
            reminders = build_reminder_messages(result['bad'], reminder=self.config.get('ID_CHECK_REMINDER', '请按本群要求修改群名片，例如「编号 昵称」。'),
                                                 per_message=max(0, int(self.config.number('ID_CHECK_PER_MESSAGE', 0))))
            if not reminders:
                reminders = [f"全群 {result['total']} 人的名片都符合「房间号 名字」的格式，太棒啦！"]
            confirmed = 0
            for index, message in enumerate(reminders):
                if not active():
                    delivery['status'] = 'cancelled'; self.save(); break
                delivery['steps'][str(index)] = 'sending'; self.save()
                try:
                    receipt = await self.onebot.send('g'+group, message)
                    if confirmed_message_id(receipt) is None:
                        delivery['steps'][str(index)] = 'uncertain'; self.save(); break
                    delivery['steps'][str(index)] = {'status': 'confirmed', 'messageId': text(receipt['message_id'])}
                    confirmed += 1; self.save()
                except BaseException as error:
                    delivery['steps'][str(index)] = 'uncertain'; delivery['status'] = 'uncertain'; self.save()
                    if isinstance(error, asyncio.CancelledError):
                        raise
                    break
                if index+1 < len(reminders):
                    await self.pause(1.2)
            delivery['status'] = 'confirmed' if confirmed == len(reminders) else 'partial' if confirmed else 'uncertain'
            self.save()
            return {**result, 'qualified': result['ok'], 'ok': confirmed == len(reminders), 'groupId': int(group), 'confirmed': confirmed, 'messages': len(reminders)}

    async def member(self, group, user):
        info = await self.onebot.member(group, user)
        info = info.get('data', info) if isinstance(info, dict) else {}
        if text(info.get('user_id')) != text(user) or info.get('role') not in {'owner', 'admin', 'member'}:
            raise ValueError('群成员实时身份未核对成功')
        return info

    async def kick_status(self, group, user):
        event = {'group_id': int(group), 'user_id': user}
        record = self.state['records'].get(text(group))
        role = 'member'
        try:
            role = (await self.member(group, self.onebot.self_id))['role']
        except Exception:
            pass
        verdict = can_kick_now(record=record, group_id=group, user_id=user, operators=self.config.ids('ID_CHECK_OPERATORS'),
            now=self.now(), is_bot_admin=role in {'admin', 'owner'}, window_ms=max(30000, self.config.number('ID_CHECK_KICK_WINDOW_MS', KICK_WINDOW_MS)))
        if record and (record.get('runtimeToken') != self.runtime_token or record.get('connection') != list(self.token())):
            verdict = {'ok': False, 'reason': '核对后运行会话已变化，请重新核对'}
        enabled = self.allowed('id-check-kick', event)
        return {'can': verdict['ok'] and enabled, 'reason': verdict['reason'] if enabled else '当前会话未启用移出成员功能',
                'enabled': enabled, 'botRole': role, 'record': copy.deepcopy(record), 'list': copy.deepcopy(verdict.get('list', [])),
                'windowMs': max(30000, self.config.number('ID_CHECK_KICK_WINDOW_MS', KICK_WINDOW_MS)),
                'gapMs': max(300, self.config.number('ID_CHECK_KICK_GAP_MS', 800))}

    async def run_kick(self, event, *, current=lambda: True):
        group, actor = text(event.get('group_id')), text(event.get('user_id'))
        lock = self.locks.setdefault(group, asyncio.Lock())
        async with lock:
            token, policy = self.token(), self.policy('id-check-kick')
            active = lambda: current() and token == self.token() and self.allowed('id-check-kick', event) and policy == self.policy('id-check-kick')
            if not active():
                return {'ok': False, 'silent': True}
            status = await self.kick_status(group, actor)
            if not status['can'] or not active():
                return {'ok': False, 'silent': True, **status}
            # The requesting account must still belong to this group. Being a
            # console administrator never substitutes for ID_CHECK_OPERATORS.
            try:
                await self.member(group, actor)
            except Exception:
                return {'ok': False, 'silent': True}
            if not active():
                return {'ok': False, 'silent': True}
            record = self.state['records'][group]
            record.update(kicked=True, status='reserved', usedAt=self.now(), operator=actor, steps={})
            self.save()
            confirmed, failed, skipped, uncertain = [], [], [], []
            people = list(dict.fromkeys(person['userId'] for person in status['list']))
            for target in people:
                if not active():
                    break
                try:
                    person = await self.member(group, target)
                    bot, operator = await asyncio.gather(self.member(group, self.onebot.self_id), self.member(group, actor))
                except Exception:
                    skipped.append(target); continue
                if not active() or bot['role'] not in {'admin', 'owner'} or int(actor) not in self.config.ids('ID_CHECK_OPERATORS'):
                    break
                if target == text(self.onebot.self_id) or int(target) in self.config.ids('ID_CHECK_SKIP') or person['role'] != 'member' or self.config.enabled('ID_CHECK_SKIP_BOTS') and likely_bot(person) or check_name(display_name(person))['ok']:
                    skipped.append(target); record['steps'][target] = 'skipped'; self.save(); continue
                record['steps'][target] = 'sending'; self.save()
                try:
                    await self.onebot.api('set_group_kick', {'group_id': int(group), 'user_id': int(target), 'reject_add_request': False})
                    confirmed.append(target); record['steps'][target] = 'confirmed'; self.save()
                except BaseException as error:
                    unknown = getattr(error, 'outcome_unknown', True)
                    (uncertain if unknown else failed).append(target)
                    record['steps'][target] = 'uncertain' if unknown else 'rejected'; self.save()
                    if isinstance(error, asyncio.CancelledError):
                        record['status'] = 'uncertain'; self.save(); raise
                    if unknown:
                        break
                if target != people[-1]:
                    await self.pause(max(300, self.config.number('ID_CHECK_KICK_GAP_MS', 800))/1000)
            record['status'] = 'uncertain' if uncertain else 'partial' if len(confirmed)+len(failed)+len(skipped) < len(people) or failed else 'confirmed'
            record['completedAt'] = self.now(); self.save()
            return {'ok': not uncertain and not failed, 'groupId': int(group), 'confirmed': confirmed, 'failed': failed,
                    'skipped': skipped, 'uncertain': uncertain, 'remaining': [value for value in people if value not in confirmed+failed+skipped+uncertain]}
