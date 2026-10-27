"""Explicit capabilities for the separate QQ Open Platform experiment."""
import re


OFFICIAL = 'qq-official'
CAPABILITIES = dict(text=True, image=True, ownRecall=True, file=False,
                    completeHistory=False, members=False, moderation=False,
                    poke=False, proactive=False)
UNAVAILABLE_FEATURES = {'owner-mute', 'self-mute', 'whole-mute', 'self-recall',
                        'request-poke', 'poke', 'music', 'summary', 'id-check',
                        'id-check-kick', 'auto-plus-one', 'send-file', 'send-link'}
UNAVAILABLE_ACTIONS = {'summary', 'send-morning-greetings', 'daily-ping', 'poke-target',
                       'id-check', 'id-check-kick', 'watch-target', 'restart-napcat',
                       'qq-login-qrcode', 'qq-switch-account', 'qq-logout', 'check-poke',
                       'restore-backup', 'memory-import', 'import-commands'}
DISABLED_SWITCHES = {'SUMMARY_ENABLED', 'QUIET_GREETINGS_ENABLED', 'DAILY_PING_ENABLED',
                     'TARGET_WATCH_ENABLED', 'POKE_REPLY_ENABLED', 'AUTO_PLUS_ONE_ENABLED',
                     'ID_CHECK_ENABLED', 'ID_CHECK_KICK_ENABLED'}


def provider(config):
    value = config.get('QQ_TRANSPORT', 'onebot').strip().lower()
    if value not in {'onebot', OFFICIAL}:
        raise ValueError('QQ_TRANSPORT只能是onebot或qq-official')
    return value


def official(config):
    return provider(config) == OFFICIAL


def unavailable(feature):
    return 'QQ官方连接试验版尚未适配此功能，未执行任何操作。'


def backend_metadata(config, transport=None):
    if not official(config):
        return {'provider': 'onebot', 'label': 'OneBot / NapCat / LLBot'}
    if transport is not None and hasattr(transport, 'metadata'):
        value = transport.metadata()
        return {**value, 'provider': OFFICIAL, 'label': 'QQ官方连接',
                'capabilities': dict(CAPABILITIES)}
    return {'provider': OFFICIAL, 'label': 'QQ官方连接', 'available': False,
            'capabilities': dict(CAPABILITIES), 'binding': {'phase': 'preview'},
            'identities': [], 'note': 'OpenID与原QQ号/群号分离；数字仅为内部编号。'}


def unsupported_request(text):
    """Block explicit unsupported requests before semantic/model execution."""
    value = str(text).strip()
    if re.match(r'[/／]\s*(?:群总结|群聊总结|今日总结|每日总结|id_check|发文件|发链接)', value, re.I):
        return True
    return bool(re.match(r'(?:请|麻烦|帮我|帮忙|能不能|可以|来|给我|把|将|再|一下|\s)*'
                         r'(?:禁言|解禁|全员禁言|开启全员|关闭全员|拍一拍|戳一戳|撤回|点歌|总结(?:一下)?群)', value))


def validate_settings(config, patch, transport=None):
    if 'QQ_TRANSPORT' in patch and not patch['QQ_TRANSPORT'].strip():
        patch['QQ_TRANSPORT'] = provider(config)
    if 'QQ_TRANSPORT' in patch and patch['QQ_TRANSPORT'].strip().lower() != provider(config):
        raise ValueError('切换QQ通道必须使用独立新实例，不能在当前数据目录改用另一种身份')
    if not official(config):
        return
    for key in DISABLED_SWITCHES:
        if str(patch.get(key, '0')).strip().lower() in {'1', 'true', 'yes', 'on'}:
            raise ValueError(unavailable(key))
    if 'PROACTIVE_RATE' in patch and float(patch['PROACTIVE_RATE']) != 0:
        raise ValueError('QQ官方连接当前仅支持有效被动回复，不支持主动搭话')
    if 'STICKER_MAX_PER_REPLY' in patch and int(patch['STICKER_MAX_PER_REPLY']) != 1:
        raise ValueError('官方接入首期每段回复最多搭配一张图片')
    rows = transport.identity_rows() if transport is not None and hasattr(transport, 'identity_rows') else []
    known = {str(row.get('alias', row.get('handle'))): row for row in rows}
    for key in {'WHITELIST_GROUPS', 'MUTED_GROUPS', 'SUMMARY_GROUPS', 'PRIVATE_WHITELIST',
                'ADMIN_USERS', 'STICKER_LEARN_GROUPS', 'STICKER_SEND_GROUPS', 'ID_CHECK_GROUPS'} & patch.keys():
        values = re.split(r'[,，\s]+', str(patch[key]).strip())
        for alias in filter(None, values):
            row = known.get(alias)
            if row is None:
                raise ValueError('请先接收官方事件，再选择已观察到的内部编号；不能填写原QQ号或群号')
            kind = row.get('kind')
            if key in {'PRIVATE_WHITELIST'} and kind != 'c2c':
                raise ValueError('私聊名单只能选择C2C OpenID对应的内部编号')
            if key == 'ADMIN_USERS' and kind not in {'c2c', 'group-user'}:
                raise ValueError('管理员只能选择本实例观察到的用户内部编号')
            if key.endswith('_GROUPS') and kind != 'group':
                raise ValueError('群名单只能选择group OpenID对应的内部编号')
