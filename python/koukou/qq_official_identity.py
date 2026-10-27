"""Private, application-scoped handles. Handles are never QQ account numbers."""
import json
from pathlib import Path
import re

from .state import read_json, write_json

PROVIDER = 'qq-official'
MARKER = 'qq-official-profile.json'
REGISTRY = 'qq-official-identities.json'
FIRST_HANDLE = 900000000000001
KINDS = {'bot', 'group', 'c2c', 'group-user', 'incoming-message', 'outgoing-message'}
LOCKS = {'bot.lock', 'bot-start.guard'}
GROUP_FIELDS = {'WHITELIST_GROUPS', 'MUTED_GROUPS', 'SUMMARY_GROUPS', 'STICKER_LEARN_GROUPS',
                'STICKER_SEND_GROUPS', 'ID_CHECK_GROUPS'}
USER_FIELDS = {'ADMIN_USERS', 'PRIVATE_WHITELIST'}


def opaque(value):
    if not isinstance(value, str) or not value or len(value) > 1024 or re.search(r'[\x00-\x20\x7f]', value):
        raise ValueError('官方身份或消息编号无效')
    return value


def safe_path(path):
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.is_symlink() or item.exists() and getattr(item.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('官方实例数据不支持链接或重解析路径')
    return path


def _load(config):
    # Config resolves paths; inspect the original spelling as well so an input
    # link cannot disappear from the safety check after resolution.
    if config.get('BOT_DATA_DIR'):
        safe_path(config.get('BOT_DATA_DIR'))
    directory = safe_path(config.data_dir)
    marker_file, registry_file = safe_path(directory/MARKER), safe_path(directory/REGISTRY)
    if not marker_file.exists():
        if directory.exists() and any(p.name not in LOCKS for p in directory.iterdir()):
            raise ValueError('官方接入必须使用独立空数据目录，不能加载旧QQ数据')
        return {'version': 1, 'provider': PROVIDER, 'appId': ''}, {'version': 1, 'next': FIRST_HANDLE, 'rows': []}
    marker = read_json(marker_file)
    if (not isinstance(marker, dict) or marker.get('version') != 1 or marker.get('provider') != PROVIDER
            or not isinstance(marker.get('appId'), str)):
        raise ValueError('官方实例身份标记无效')
    if marker['appId']:
        opaque(marker['appId'])
    registry = read_json(registry_file, {'version': 1, 'next': FIRST_HANDLE, 'rows': []})
    if not registry_file.exists() and any(p.name not in LOCKS | {MARKER} for p in directory.iterdir()):
        raise ValueError('官方身份映射缺失，拒绝猜测会话身份')
    if (not isinstance(registry, dict) or registry.get('version') != 1 or not isinstance(registry.get('rows'), list)
            or isinstance(registry.get('next'), bool) or not isinstance(registry.get('next'), int)
            or not FIRST_HANDLE <= registry['next'] <= 999999999999999):
        raise ValueError('官方身份映射损坏')
    handles, subjects = set(), set()
    for row in registry['rows']:
        if (not isinstance(row, dict) or row.get('provider') != PROVIDER or row.get('kind') not in KINDS
                or not marker['appId'] or row.get('appId') != marker['appId']
                or not isinstance(row.get('handle'), str) or not row['handle'].isdecimal()
                or not FIRST_HANDLE <= int(row['handle']) < registry['next'] or not isinstance(row.get('parent', ''), str)):
            raise ValueError('官方身份映射条目无效')
        opaque(row.get('opaqueId'))
        subject = (row['kind'], row.get('parent', ''), row['opaqueId'])
        if row['handle'] in handles or subject in subjects:
            raise ValueError('官方身份映射重复')
        handles.add(row['handle']); subjects.add(subject)
    return marker, registry


def validate_official_profile(config):
    """Read-only; reject inherited OneBot settings and untyped identity imports."""
    for key in ('ONEBOT_WS_URL', 'ONEBOT_ACCESS_TOKEN', 'NAPCAT_DIR', 'NAPCAT_WEBUI_URL',
                'NAPCAT_WEBUI_TOKEN', 'LLBOT_WEBUI_URL', 'LLBOT_WEBUI_TOKEN'):
        if config.get(key).strip():
            raise ValueError('官方接入不能继承OneBot/NapCat/LLBot配置，请使用独立配置')
    marker, registry = _load(config)
    expected = config.get('QQ_OFFICIAL_APP_ID').strip()
    if expected and marker['appId'] and expected != marker['appId']:
        raise ValueError('官方应用身份不匹配，请使用另一个独立数据目录')
    rows = {row['handle']: row for row in registry['rows']}
    for key in GROUP_FIELDS | USER_FIELDS:
        value = config.get(key).strip()
        if not value:
            continue
        pieces = re.split(r'[,，\s]+', value)
        for handle in pieces:
            row = rows.get(handle)
            allowed = {'group'} if key in GROUP_FIELDS else {'c2c'} if key == 'PRIVATE_WHITELIST' else {'c2c', 'group-user'}
            if row is None or row['kind'] not in allowed:
                raise ValueError('官方名单只能选择已观察到、类型匹配的内部身份，不能填写旧QQ号')
    return {'provider': PROVIDER, 'appId': marker['appId'], 'isolated': True}


class IdentityRegistry:
    def __init__(self, config):
        validate_official_profile(config)
        self.config = config
        self.marker, self.data = _load(config)
        self.directory = config.data_dir
        # Runtime owns the instance lock before constructing this registry.
        self.directory.mkdir(parents=True, exist_ok=True)
        if not (self.directory/MARKER).exists():
            write_json(self.directory/MARKER, self.marker)
        if not (self.directory/REGISTRY).exists():
            self.save()

    @property
    def app_id(self):
        return self.marker['appId']

    def bind(self, app_id):
        opaque(app_id)
        expected = self.config.get('QQ_OFFICIAL_APP_ID').strip()
        if self.app_id and self.app_id != app_id or expected and expected != app_id:
            raise ValueError('官方应用已变化，拒绝混用身份和记忆；请使用独立实例')
        if not self.app_id:
            marker = {**self.marker, 'appId': app_id}
            write_json(self.directory/MARKER, marker)
            self.marker = marker

    def save(self):
        write_json(self.directory/REGISTRY, self.data)

    def allocate(self, kind, value, parent='', **metadata):
        if not self.app_id or kind not in KINDS:
            raise ValueError('官方应用尚未绑定或身份类型不支持')
        opaque(value)
        for row in self.data['rows']:
            if (row['kind'], row.get('parent', ''), row['opaqueId']) == (kind, parent, value):
                return row['handle']
        handle = str(self.data['next'])
        before = {'version': self.data['version'], 'next': self.data['next'], 'rows': list(self.data['rows'])}
        self.data['next'] += 1
        if self.data['next'] > 999999999999999:
            raise ValueError('官方内部身份编号空间已满')
        self.data['rows'].append({'handle': handle, 'provider': PROVIDER, 'appId': self.app_id,
                                  'kind': kind, 'opaqueId': value, 'parent': parent, **metadata})
        try:
            self.save()
        except BaseException:
            self.data = before
            raise
        return handle

    def get(self, handle, kinds=None):
        row = next((row for row in self.data['rows'] if row['handle'] == str(handle)), None)
        if row is None or kinds is not None and row['kind'] not in kinds:
            raise ValueError('未知或类型不匹配的官方内部身份')
        return dict(row)

    @staticmethod
    def target_context(scope, target):
        return json.dumps([scope, target], ensure_ascii=False, separators=(',', ':'))

    def identities(self):
        return [dict(row) for row in self.data['rows'] if row['kind'] in {'bot', 'group', 'c2c', 'group-user'}]
