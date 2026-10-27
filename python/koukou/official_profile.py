"""Create a new private official-QQ trial profile; never imports old identities."""
from pathlib import Path
import re
import secrets
from .state import write_text


def prepare_profile(destination, *, console_port=8791, bridge_port=8792):
    root = Path(destination)
    if not root.is_absolute() or root.exists() or not root.parent.is_dir():
        raise ValueError('官方试验目录必须是父目录已存在、尚未创建的绝对路径')
    for port in (console_port, bridge_port):
        if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
            raise ValueError('端口必须为1024~65535')
    if console_port == bridge_port:
        raise ValueError('控制台与官方桥必须使用不同端口')
    root = root.resolve()
    if re.search(r'[\r\n\0]', str(root)):
        raise ValueError('目录名无效')
    root.mkdir(mode=0o700)
    for child in ('data', 'logs', 'bridge'):
        (root/child).mkdir(mode=0o700)
    settings = {
        'QQ_TRANSPORT': 'qq-official', 'BOT_PROFILE': 'qq-official-trial',
        'BOT_DATA_DIR': str(root/'data'), 'BOT_LOG_DIR': str(root/'logs'),
        'ADMIN_ENABLED': '1', 'ADMIN_PORT': str(console_port),
        'QQ_OFFICIAL_BRIDGE_URL': f'ws://127.0.0.1:{bridge_port}/bridge',
        'KOUKOU_QQ_BRIDGE_TOKEN': secrets.token_urlsafe(36), 'QQ_OFFICIAL_APP_ID': '',
        'DEEPSEEK_API_KEY': '', 'DEEPSEEK_BASE_URL': 'https://api.deepseek.com',
        'DEEPSEEK_MODEL': 'deepseek-flash', 'DEEPSEEK_REASONING_EFFORT': 'max',
        'WHITELIST_GROUPS': '', 'PRIVATE_WHITELIST': '', 'ADMIN_USERS': '',
        'PROACTIVE_RATE': '0', 'SUMMARY_ENABLED': '0', 'QUIET_GREETINGS_ENABLED': '0',
        'DAILY_PING_ENABLED': '0', 'TARGET_WATCH_ENABLED': '0', 'POKE_REPLY_ENABLED': '0',
        'AUTO_PLUS_ONE_ENABLED': '0', 'STICKER_LEARN_ENABLED': '0', 'STICKER_LEARN_PRIVATE': '0',
        'STICKERS_ENABLED': '1', 'STICKER_AUTO_RATE': '35', 'CONTEXT_REMEMBER_ALL': '1',
        'QUIET_HOURS': '01:00-07:00', 'QUIET_HOURS_BLOCK_ALL': '1',
    }
    write_text(root/'profile.env', ''.join(key+'='+value+'\n' for key,value in settings.items()))
    write_text(root/'persona.txt', '你是友好、认真、说话自然的小助手。按事实回答，不声称执行过未确认的操作。\n')
    return {'ok': True, 'root': str(root), 'envFile': str(root/'profile.env'),
            'dataDir': str(root/'data'), 'logDir': str(root/'logs'),
            'bridgeStateDir': str(root/'bridge'/'state'),
            'credentialsFile': str(root/'bridge'/'credentials.json'),
            'consolePort': console_port, 'bridgePort': bridge_port,
            'connected': False, 'credentialsImported': False, 'ready': False}
