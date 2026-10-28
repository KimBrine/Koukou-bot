"""Resolve an explicit native launch without creating files or connecting."""
import os
from pathlib import Path

from .config import Config


def console_port(config):
    """Keep the existing console's configured port range and numeric behavior."""
    return max(1024, min(65535, int(config.number('ADMIN_PORT', 8787))))


def resolve_native_config(root, env_file=None, *, data_dir=None, log_dir=None,
                          profile=None, port=None, environ=None):
    """Require instance paths from arguments or the launching process itself.

    Paths merely present inside a .env are insufficient: an old Node profile
    can otherwise silently fall back to Python's fresh empty data directory.
    No directory, instance lock, or default configuration is created here.
    """
    environment = dict(os.environ if environ is None else environ)
    selected = {}
    for key, argument in (('BOT_DATA_DIR', data_dir), ('BOT_LOG_DIR', log_dir)):
        value = argument if argument is not None else environment.get(key)
        if value is None or not str(value).strip():
            raise ValueError(f'原生运行必须显式提供绝对路径：{key}（启动环境或对应目录参数）')
        path = Path(value)
        if not path.is_absolute():
            raise ValueError(f'{key}必须是绝对路径')
        path = path.resolve()
        if path.exists() and not path.is_dir():
            raise ValueError(f'{key}必须指向目录')
        selected[key] = str(path)
    if port is not None and (isinstance(port, bool) or not isinstance(port, int)
                             or not 1024 <= port <= 65535):
        raise ValueError('原生控制台端口必须在1024~65535之间')
    environment.update(selected)
    config = Config(root, env_file, environ=environment)
    if not config.env_file.is_file():
        raise ValueError('原生运行必须使用已存在的实例配置文件，请通过--env-file或BOT_ENV_FILE指定')
    active_profile = str(profile if profile is not None else config.get('BOT_PROFILE', 'main')).strip()
    if not active_profile or len(active_profile) > 128 or any(c in active_profile for c in '\r\n\x00'):
        raise ValueError('BOT_PROFILE无效')
    # Pin the resolved identity for every in-process restart as well.
    config.environ['BOT_PROFILE'] = active_profile
    config.values['BOT_PROFILE'] = active_profile
    return config


def native_plan(config, port=None):
    """Public launch metadata only; never include credentials or model inputs."""
    return {
        'backend': 'python', 'root': str(config.root), 'envFile': str(config.env_file),
        'dataDir': str(config.data_dir), 'logDir': str(config.log_dir),
        'profile': config.get('BOT_PROFILE'),
        'console': {'enabled': config.enabled('ADMIN_ENABLED'), 'host': '127.0.0.1',
                    'port': console_port(config) if port is None else port},
        'readOnly': True,
    }
