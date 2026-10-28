"""Atomic UTF-8 state. Corrupt files fail closed instead of being overwritten."""
import copy
import json
import os
from pathlib import Path
import uuid


def write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return copy.deepcopy(default)
    try:
        def invalid(value):
            raise ValueError("JSON不支持非有限数值："+value)
        return json.loads(path.read_text(encoding="utf-8-sig"), parse_constant=invalid)
    except (ValueError, UnicodeError) as exc:
        raise ValueError(f"状态文件损坏，停止写入，请恢复备份：{path}") from exc


def write_json(path, value):
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def boot_time_ms():
    import time
    if os.name == 'nt':
        import ctypes
        uptime = ctypes.windll.kernel32.GetTickCount64
        uptime.restype = ctypes.c_ulonglong
        return time.time()*1000-uptime()
    if hasattr(time,'CLOCK_BOOTTIME'):
        return time.time()*1000-time.clock_gettime(time.CLOCK_BOOTTIME)*1000
    return None


def pid_alive(pid):
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000,False,pid)
        if handle:
            kernel.CloseHandle.argtypes=[ctypes.c_void_p]
            kernel.CloseHandle(handle);return True
        return ctypes.get_last_error()!=87  # Access denied/unknown is not proof of death.
    try:os.kill(pid,0);return True
    except ProcessLookupError:return False
    except (PermissionError,OSError):return True


def process_image(pid):
    """Read identity only; never terminate a process when recovering a stale lock."""
    if os.name=='nt':
        import ctypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.restype=ctypes.c_void_p
        handle=kernel.OpenProcess(0x1000,False,pid)
        if not handle:return None
        try:
            buffer=ctypes.create_unicode_buffer(32768);size=ctypes.c_ulong(len(buffer))
            kernel.QueryFullProcessImageNameW.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_ulong)]
            return buffer.value if kernel.QueryFullProcessImageNameW(handle,0,buffer,ctypes.byref(size)) else None
        finally:
            kernel.CloseHandle.argtypes=[ctypes.c_void_p];kernel.CloseHandle(handle)
    try:return os.readlink(f'/proc/{pid}/exe')
    except OSError:return None


class InstanceLock:
    """Cross-runtime lock; optional recovery requires a dead PID or another boot."""
    def __init__(self, directory, *, recover_stale=False, boot_time=boot_time_ms, alive=pid_alive, image=process_image):
        self.path = Path(directory) / "bot.lock"
        self.token, self.owned = uuid.uuid4().hex, False
        self.recover_stale,self.boot_time,self.alive = recover_stale,boot_time,alive
        self.image=image

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        guard_file=self.path.with_name('bot-start.guard')
        if guard_file.is_symlink() or self.path.is_symlink():raise RuntimeError('实例锁不支持链接路径')
        guard=guard_file.open('a+b')
        try:
            # The OS releases this startup guard even if a process crashes.
            if os.name=='nt':
                import msvcrt
                guard.seek(0,2)
                if guard.tell()==0:guard.write(b'0');guard.flush()
                guard.seek(0)
                try:msvcrt.locking(guard.fileno(),msvcrt.LK_NBLCK,1)
                except OSError as error:raise RuntimeError('另一个实例正在启动，请稍后重试') from error
            else:
                import fcntl
                try:fcntl.flock(guard.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
                except OSError as error:raise RuntimeError('另一个实例正在启动，请稍后重试') from error
            boot=self.boot_time()
            if self.path.exists():
                import math
                old=read_json(self.path)
                if not isinstance(old,dict):raise RuntimeError('实例锁格式未知，请检查后手动恢复')
                pid=old.get('pid')
                if not self.recover_stale or not isinstance(pid,int) or isinstance(pid,bool) or not 0<pid<=0xffffffff:
                    raise RuntimeError('数据目录已有bot.lock，拒绝同时运行两个实例')
                old_boot=old.get('bootAt')
                other_boot=(boot is not None and isinstance(old_boot,(int,float)) and not isinstance(old_boot,bool)
                            and math.isfinite(old_boot) and abs(old_boot-boot)>60000)
                if self.alive(pid):
                    executable=self.image(pid)
                    backend=(not executable or Path(executable).stem.lower() in {'node','python','pythonw'} or Path(executable).stem.lower().startswith('python3'))
                    if not other_boot or backend:
                        raise RuntimeError('数据目录已有活跃或无法判定的bot.lock，拒绝同时运行两个实例')
                self.path.unlink()
            try:
                with self.path.open('x',encoding='utf-8') as stream:
                    json.dump({'pid':os.getpid(),'runtime':'python','token':self.token,'bootAt':boot},stream)
                    stream.flush();os.fsync(stream.fileno())
            except FileExistsError as error:
                raise RuntimeError('另一个运行时已启动，拒绝重复实例') from error
        finally:
            guard.close()
        self.owned = True
        return self

    def close(self):
        if self.owned:
            if read_json(self.path, {}).get("token") == self.token:
                self.path.unlink(missing_ok=True)
            self.owned = False

    __enter__ = acquire

    def __exit__(self, *_):
        self.close()
