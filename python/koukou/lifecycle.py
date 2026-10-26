"""Explicit host operations, scoped to one configured instance and never on import."""
import asyncio
import os
from pathlib import Path
import re
import subprocess
import sys


async def finish_cleanup(awaitable):
    """Finish owned cleanup even if its caller receives repeated cancellation.

    Cancellation is propagated after cleanup, while a cancelled/failed cleanup
    task itself is never treated as successful shutdown.
    """
    task = asyncio.ensure_future(awaitable)
    cancelled = None
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError as error:
            if task.cancelled():
                raise
            cancelled = error
            if task.done():
                result = task.result()
                break
    if cancelled is not None:
        raise cancelled
    return result


async def run_program(argv,timeout=30):
    options={'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}
    process=await asyncio.create_subprocess_exec(*argv,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,**options)
    try:
        out,error=await asyncio.wait_for(process.communicate(),timeout)
        if process.returncode:
            raise RuntimeError('本机操作未完成：'+error.decode('utf-8',errors='replace')[-400:])
        return out.decode('utf-8',errors='replace')
    finally:
        if process.returncode is None:
            process.kill();await process.wait()


class Lifecycle:
    def __init__(self,config,*,restart=None,runner=run_program,platform=sys.platform,opener=None):
        self.config,self.restart,self.runner,self.platform,self.opener=config,restart,runner,platform,opener

    def restart_bot(self):
        if self.restart is None:raise RuntimeError('当前入口未配置安全重启，请使用原启动入口重新加载')
        asyncio.get_running_loop().call_later(.3,self.restart)
        return {'ok':True}

    async def restart_protocol(self):
        if self.platform!='win32':raise ValueError('协议端计划任务重启仅支持Windows，请使用协议端自身的重启入口')
        raw=self.config.get('NAPCAT_DIR')
        if not raw:raise ValueError('请先配置该实例的NAPCAT_DIR')
        directory=Path(raw).expanduser()
        if not directory.is_absolute():directory=self.config.env_file.parent/directory
        directory=directory.resolve(strict=True)
        if not directory.is_dir() or directory.parent==directory or directory==Path(directory.anchor):
            raise ValueError('协议端目录必须是明确的实例文件夹')
        task=self.config.get('NAPCAT_TASK_NAME','NapCatQQ')
        if not re.fullmatch(r'[\w .\-\u4e00-\u9fff]{1,128}',task):raise ValueError('计划任务名称无效')
        helper=Path(__file__).with_name('windows_restart.ps1')
        await self.runner(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(helper),'-ProtocolDir',str(directory),'-TaskName',task],timeout=45)
        return {'ok':True,'killed':'verified-instance-then-start','dir':str(directory),'task':task}

    def open_folder(self,path):
        if self.platform!='win32':raise ValueError('仅Windows支持打开资源管理器，请复制路径在机器人所在电脑打开')
        target=Path(path).resolve()
        target.mkdir(parents=True,exist_ok=True)
        (self.opener or os.startfile)(str(target))
        return {'ok':True,'path':str(target),'mode':'folder','warning':'已请求在机器人所在电脑打开；若未出现窗口，请复制路径手动打开'}
