"""Local installation launcher; operates only on this installation's profile."""
import argparse
import ctypes
from ctypes import wintypes
import json
import msvcrt
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
PROFILE = ROOT / 'profile'
PYTHON = ROOT / '.venv' / 'Scripts' / 'python.exe'
NODE = Path(r'C:\Program Files\nodejs\node.exe')
LOGS = PROFILE / 'logs'
STATE = ROOT / 'runtime.json'
STOP = PROFILE / 'bridge' / 'stop.request'
BASE = [str(PYTHON), '-m', 'koukou', '--root', str(PROFILE), '--env-file', str(PROFILE / 'profile.env')]
PARAMS = ['--data-dir', str(PROFILE / 'data'), '--log-dir', str(LOGS), '--profile', 'qq-official-trial', '--port', '8791']
ENV = {k: v for k, v in os.environ.items() if k.upper() in {
    'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS'
}}
ENV.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
KERNEL = ctypes.WinDLL('kernel32', use_last_error=True)
KERNEL.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
KERNEL.OpenProcess.restype = wintypes.HANDLE
KERNEL.CloseHandle.argtypes = [wintypes.HANDLE]
KERNEL.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
KERNEL.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]


def creation(pid):
    handle = KERNEL.OpenProcess(0x1000 | 0x100000, False, int(pid))
    if not handle:
        return None
    try:
        if KERNEL.WaitForSingleObject(handle, 0) != 258:
            return None
        values = [wintypes.FILETIME() for _ in range(4)]
        if not KERNEL.GetProcessTimes(handle, *(ctypes.byref(x) for x in values)):
            return None
        return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime
    finally:
        KERNEL.CloseHandle(handle)


def alive(item):
    return bool(item and creation(item['pid']) == item['created'])


def process_state(pid):
    """Only an explicit missing/exited process proves a stale lock is safe to recover."""
    handle = KERNEL.OpenProcess(0x1000 | 0x100000, False, int(pid))
    if not handle:
        return 'dead' if ctypes.get_last_error() == 87 else 'unknown'
    try:
        result = KERNEL.WaitForSingleObject(handle, 0)
        return 'dead' if result == 0 else 'alive' if result == 258 else 'unknown'
    finally:
        KERNEL.CloseHandle(handle)


def recover_bridge_lock():
    """Caller holds launcher.lock. Archive only a verified dead bridge's exact lock."""
    lock = PROFILE / 'bridge' / 'state' / '.bridge.lock'
    if not lock.exists():
        return False
    if lock.is_symlink() or not lock.is_file() or lock.stat().st_size > 8192:
        raise RuntimeError('官方连接桥的锁文件异常，已停止启动；未改动登录资料。')
    previous = lock.read_bytes()
    try:
        value = json.loads(previous)
    except (ValueError, UnicodeError):
        raise RuntimeError('官方连接桥的锁文件无法识别，请检查运行日志。') from None
    pid = value.get('pid') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or value.get('protocol') != 'koukou-qq-official-v1' or type(pid) is not int
            or not 0 < pid <= 0xffffffff or not isinstance(value.get('token'), str)):
        raise RuntimeError('官方连接桥的锁文件身份不匹配，未自动处理。')
    if process_state(pid) != 'dead':
        raise RuntimeError('官方连接桥仍在运行，或无法确认其状态。请先使用“停止官方QQ版”，不会重复启动。')
    if lock.read_bytes() != previous:
        raise RuntimeError('官方连接桥的锁已变化，请稍后重试；未覆盖新实例。')
    os.replace(lock, lock.with_name('.bridge.lock.stale-' + uuid.uuid4().hex))
    print('已确认旧连接桥退出，归档残留锁并恢复启动。')
    return True


def read_state():
    if not STATE.exists():
        return {}
    value = json.loads(STATE.read_text(encoding='utf-8'))
    if value.get('installation') != str(ROOT):
        raise RuntimeError('Installation identity mismatch; no process was stopped.')
    return value


def occupied(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def fetch_state():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:8791/api/state', timeout=3) as response:
        return json.load(response)


def spawn(name, command, state):
    with (LOGS / f'{name}.stdout.log').open('ab') as out, (LOGS / f'{name}.stderr.log').open('ab') as err:
        child = subprocess.Popen(command, cwd=ROOT / 'app', env=ENV, stdin=subprocess.DEVNULL,
            stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
    stamp = creation(child.pid)
    if stamp is None:
        raise RuntimeError(f'{name} exited during startup; see logs.')
    state[name] = {'pid': child.pid, 'created': stamp}
    STATE.write_text(json.dumps(state, indent=2), encoding='utf-8')


def stop():
    state = read_state()
    if alive(state.get('python')):
        result = subprocess.run(BASE + ['stop-native'] + PARAMS + ['--execute'], cwd=ROOT / 'app', env=ENV,
            capture_output=True, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW, timeout=45)
        if result.returncode:
            raise RuntimeError('Python graceful stop failed; bridge left running. See stop log.')
        (LOGS / 'last-stop.log').write_text(result.stdout, encoding='utf-8')
        deadline = time.monotonic() + 10
        while alive(state.get('python')) and time.monotonic() < deadline:
            time.sleep(.2)
        if alive(state.get('python')):
            raise RuntimeError('Python has not stopped; no forced termination was used.')
    if alive(state.get('bridge')):
        STOP.write_text('stop\n', encoding='utf-8')
        deadline = time.monotonic() + 20
        while alive(state.get('bridge')) and time.monotonic() < deadline:
            time.sleep(.2)
        if alive(state.get('bridge')):
            raise RuntimeError('Bridge has not stopped; no forced termination was used.')
    print('Official QQ installation stopped cleanly.')


def start():
    state = read_state()
    running = [alive(state.get(key)) for key in ('bridge', 'python')]
    if all(running):
        fetch_state()
        print('Official QQ installation is already running: http://127.0.0.1:8791/')
        return
    if any(running):
        raise RuntimeError('当前只有部分服务在运行。请先点击“停止官方QQ版”，再重新启动。')
    if any(occupied(port) for port in (8791, 8792)):
        raise RuntimeError('端口8791或8792已被占用。未关闭或替换其他服务，请先检查占用程序。')
    recover_bridge_lock()
    state = {'installation': str(ROOT), 'commit': json.loads((ROOT / 'installation.json').read_text(encoding='utf-8'))['commit']}
    spawn('bridge', [str(NODE), str(ROOT / 'official-host.mjs'), '--env-file', str(PROFILE / 'profile.env'),
        '--credentials-file', str(PROFILE / 'bridge' / 'credentials.json'), '--state-dir', str(PROFILE / 'bridge' / 'state'),
        '--port', '8792', '--enable-qq'], state)
    try:
        deadline = time.monotonic() + 15
        while not occupied(8792):
            if not alive(state['bridge']) or time.monotonic() > deadline:
                raise RuntimeError('官方QQ连接桥启动失败。详细原因见安装目录 profile\\logs\\bridge.stderr.log。')
            time.sleep(.2)
        spawn('python', BASE + ['run', '--enable-native'] + PARAMS, state)
        deadline = time.monotonic() + 30
        while True:
            if not alive(state['python']):
                raise RuntimeError('Python backend exited; see logs.')
            try:
                fetch_state()
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('Control panel startup timed out; see logs.')
                time.sleep(.4)
    except Exception:
        stop()
        raise
    print('Official QQ installation started: http://127.0.0.1:8791/')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['start', 'stop', 'status'])
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    LOGS.mkdir(parents=True, exist_ok=True)
    with (ROOT / 'launcher.lock').open('a+b') as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b'0'); lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise RuntimeError('另一个启动或停止操作正在进行，请稍后重试。') from None
        if args.action == 'start':
            start()
            if args.open:
                os.startfile('http://127.0.0.1:8791/')
        elif args.action == 'stop':
            stop()
        else:
            state = read_state()
            print(json.dumps({'bridgeRunning': alive(state.get('bridge')), 'pythonRunning': alive(state.get('python'))}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        LOGS.mkdir(parents=True, exist_ok=True)
        (LOGS / 'launcher-error.log').write_text(str(error), encoding='utf-8')
        if sys.stderr:
            print(str(error), file=sys.stderr)
        else:
            ctypes.windll.user32.MessageBoxW(None, str(error), 'Koukou Studio QQ Official', 0x10)
        raise SystemExit(1)
