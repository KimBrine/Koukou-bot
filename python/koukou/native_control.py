"""Local graceful control tied to a native host's exact lock generation.

Never signals or kills a process. A missing/changed identity is a refusal, not
permission to fall back to the legacy Node stop scripts.
"""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys

from .native_cli import console_port
from .state import pid_alive, read_json


def _lock(config):
    file = config.data_dir / 'bot.lock'
    if file.is_symlink():
        raise ValueError('原生实例锁不能是链接')
    value = read_json(file, {})
    if (not isinstance(value, dict) or value.get('runtime') != 'python'
            or isinstance(value.get('pid'), bool) or not isinstance(value.get('pid'), int)
            or value['pid'] <= 0 or not isinstance(value.get('token'), str)
            or not re.fullmatch(r'[a-f0-9]{32}', value['token'])):
        raise ValueError('没有可确认的原生Python实例锁；未发送停止请求')
    return value


def _identity(config, value):
    metadata = {
        'runtime': 'python', 'mode': 'native', 'pid': value['pid'],
        'profile': config.get('BOT_PROFILE'), 'root': str(config.root),
        'envFile': str(config.env_file), 'dataDir': str(config.data_dir),
        'logDir': str(config.log_dir),
    }
    raw = json.dumps([metadata, value['token']], sort_keys=True, separators=(',', ':'))
    return {**metadata, 'identity': hashlib.sha256(raw.encode()).hexdigest()}


def host_identity(config, lock):
    value = _lock(config)
    if (not lock.owned or value['pid'] != os.getpid()
            or not hmac.compare_digest(value['token'], lock.token)):
        raise RuntimeError('原生实例锁归属已变化，停止能力已拒绝')
    return _identity(config, value)


def _windows_exited(pid, kernel=None):
    import ctypes
    kernel = kernel or ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.WaitForSingleObject.restype = ctypes.c_ulong
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x100000 | 0x1000, False, pid)
    if not handle:
        return kernel.GetLastError() == 87  # Other errors leave ownership unknown.
    try:
        # Process objects can survive termination while a parent holds a handle.
        return kernel.WaitForSingleObject(handle, 0) == 0  # WAIT_OBJECT_0
    finally:
        kernel.CloseHandle(handle)


def _exited(pid):
    if sys.platform == 'win32':
        return _windows_exited(pid)
    if not pid_alive(pid):
        return True
    # A test supervisor may not have reaped its child yet. Linux zombies have
    # already exited; kill(pid, 0) alone still reports their PID as existing.
    if sys.platform.startswith('linux'):
        try:
            return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0] in {'Z', 'X'}
        except (OSError, IndexError):
            pass
    return False


async def stop_native(config, *, port=None, execute=False, timeout=15):
    """Inspect by default; explicitly request graceful shutdown once, then verify.

    Only fixed loopback HTTP is used. Redirects, environment proxies and any
    process-kill fallback are deliberately unavailable.
    """
    from aiohttp import ClientError
    try:
        return await _stop_native(config, port=port, execute=execute, timeout=timeout)
    except (ClientError, OSError, asyncio.TimeoutError) as error:
        raise RuntimeError('本机原生控制连接未获确认；未重试，也不会强制终止，请核对实例状态') from error


async def _stop_native(config, *, port, execute, timeout):
    from aiohttp import ClientSession, ClientTimeout
    if not config.enabled('ADMIN_ENABLED'):
        raise ValueError('ADMIN_ENABLED=0无法管理式停止；请在原前台使用Ctrl+C，不会强制终止')
    if not 1 <= timeout <= 300:
        raise ValueError('停止等待必须在1~300秒之间')
    port = console_port(config) if port is None else port
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError('原生控制台端口必须在1024~65535之间')
    original = _lock(config)
    expected = _identity(config, original)
    base = f'http://127.0.0.1:{port}'

    async with ClientSession(trust_env=False, timeout=ClientTimeout(total=min(timeout, 15))) as client:
        async with client.get(base+'/api/native-instance', allow_redirects=False) as response:
            if response.status != 200:
                raise RuntimeError('控制台不是匹配的可管理原生实例；未发送停止请求')
            remote = await response.json()
        if remote != expected or _lock(config) != original:
            raise ValueError('实例身份、profile或路径不匹配；未发送停止请求')
        plan = {key: value for key, value in expected.items() if key != 'identity'}
        plan.update(readOnly=not execute, requested=False, stopped=False)
        if not execute:
            return plan
        async with client.get(base+'/', allow_redirects=False) as response:
            if response.status != 200:
                raise RuntimeError('未取得原生控制台鉴权页面；未发送停止请求')
            body = await response.content.read(2*1024*1024)
        match = re.search(rb'window\.__ADMIN_TOKEN__=("[^"\r\n]+")', body)
        if not match:
            raise RuntimeError('未取得原生控制台令牌；未发送停止请求')
        token = json.loads(match.group(1))
        if _lock(config) != original:
            raise ValueError('请求前实例锁已变化；未发送停止请求')
        # Exactly one POST. A failed/unknown response is never replayed.
        async with client.post(base+'/api/action/shutdown-native',
                json={'identity': expected['identity']},
                headers={'X-Admin-Token': token, 'Origin': base},
                allow_redirects=False) as response:
            if response.status != 200 or (await response.json()) != {'ok': True, 'accepted': True}:
                raise RuntimeError('原生停止未获确认，不会重试或强制终止')
        plan['requested'] = True
        deadline = asyncio.get_running_loop().time()+timeout
        while asyncio.get_running_loop().time() < deadline:
            present = read_json(config.data_dir/'bot.lock', {})
            if not isinstance(present, dict):
                raise RuntimeError('关闭期间实例锁格式已变化；状态待核验，不会强制终止')
            exited = _exited(original['pid'])
            if exited and present.get('token') != original['token']:
                return {**plan, 'stopped': True, 'replacementDetected': bool(present)}
            if present and present.get('token') != original['token']:
                raise RuntimeError('请求后实例代际已变化；不会关闭新的实例，请重新核验')
            await asyncio.sleep(.1)
        raise RuntimeError('已请求原生关闭，但等待退出超时；状态待核验，不会强制终止')
