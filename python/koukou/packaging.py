"""Ordinary ZIP/7z/RAR packing for native file commands; never password or suffix hiding."""
import asyncio
from dataclasses import dataclass
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid

FORMATS = {'zip','7z','rar'}
DEFAULT_7Z = ['C:/Program Files/7-Zip/7z.exe','C:/Program Files (x86)/7-Zip/7z.exe','D:/7-Zip/7z.exe','/usr/bin/7z','/usr/bin/7zz','/usr/local/bin/7z','/opt/homebrew/bin/7z']
DEFAULT_RAR = ['C:/Program Files/WinRAR/Rar.exe','C:/Program Files (x86)/WinRAR/Rar.exe']


def normalize_format(value):
    value = str(value or '').strip().lower()
    return value if value in FORMATS else 'zip'


def normalize_passes(value):
    try:
        return max(1,min(5,math.floor(float(value))))
    except (ValueError,TypeError,OverflowError):
        return 1


def reparse(path):
    try:
        return path.is_symlink() or bool(getattr(path.lstat(),'st_file_attributes',0) & 0x400)
    except FileNotFoundError:
        return False


def local_source(value, *, root=None, roots=None):
    text = str(value).strip().strip('"')
    if not text or any(c in text for c in '\0\r\n') or text.startswith(('\\\\','//')) or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://',text):
        raise ValueError('只支持明确指定的本机文件路径')
    raw = Path(text).expanduser()
    if not raw.is_absolute():
        raw = Path(root or Path.cwd())/raw
    # Reject links before resolution, including Windows directory junctions and ADS.
    for part in [raw,*raw.parents]:
        if reparse(part):
            raise ValueError('文件路径不能经过符号链接或目录联接')
    if os.name == 'nt' and any(':' in p for p in raw.parts[1:]):
        raise ValueError('不支持文件附加数据流')
    path = raw.resolve(strict=True)
    if not path.is_file() and not path.is_dir():
        raise ValueError('不是普通文件或目录')
    if roots is not None and not any(path == Path(base).resolve() or Path(base).resolve() in path.parents for base in roots):
        raise ValueError('文件不在管理员指定的可发送目录中')
    return path


def inspect_tree(source, *, max_files=100000):
    if reparse(source):
        raise ValueError('打包源不能是符号链接')
    if source.is_file():
        return
    count = 0
    for directory,dirs,files in os.walk(source,followlinks=False):
        for name in [*dirs,*files]:
            path = Path(directory)/name
            if reparse(path):
                raise ValueError('打包目录内不能包含符号链接或目录联接')
            if not path.is_dir() and not path.is_file():
                raise ValueError('打包目录内存在特殊文件')
            count += 1
            if count > max_files:
                raise ValueError('打包目录条目过多')


def find_tool(preferred,candidates,names):
    paths = [str(preferred or '').strip().strip('"'),*candidates]
    paths.extend(shutil.which(name) or '' for name in names)
    for candidate in paths:
        if not candidate:
            continue
        path = Path(candidate)
        options = [path/name for name in names] if path.is_dir() else [path]
        for option in options:
            if option.is_file():
                return str(option.resolve())
    return ''


async def run_archive(command,args,*,cwd,timeout=600):
    """Bound stdout/stderr, kill the complete child tree on cancellation or timeout."""
    options = {'creationflags':subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session':True}
    process = await asyncio.create_subprocess_exec(str(command),*map(str,args),cwd=str(cwd),env={**os.environ,'PYTHONUTF8':'1','PYTHONIOENCODING':'utf-8'},stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,**options)
    async def read(stream):
        chunks,size = [],0
        while chunk := await stream.read(65536):
            size += len(chunk)
            if size > 1024*1024:
                raise ValueError('压缩程序输出超过1MB')
            chunks.append(chunk)
        return b''.join(chunks).decode('utf-8',errors='replace')
    tasks = [asyncio.create_task(read(process.stdout)),asyncio.create_task(read(process.stderr)),asyncio.create_task(process.wait())]
    try:
        stdout,stderr,code = await asyncio.wait_for(asyncio.gather(*tasks),timeout)
        if code:
            raise RuntimeError('打包失败：'+(stderr or stdout or f'退出码 {code}')[-300:])
        return {'stdout':stdout,'stderr':stderr,'code':code}
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        if process.returncode is None:
            if os.name == 'nt':
                killer = await asyncio.create_subprocess_exec('taskkill','/PID',str(process.pid),'/T','/F',stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
                await killer.wait()
            else:
                try:
                    os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:
                    pass
        await process.communicate()


ZIP_WORKER = r'''import os,sys,zipfile
from pathlib import Path
source,out=map(Path,sys.argv[1:3])
def safe(path):
    for p in [path,*path.parents]:
        if p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0)&0x400:
            raise ValueError('archive source changed into a link')
safe(source)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=9,allowZip64=True) as archive:
    if source.is_dir():
        for directory,dirs,files in os.walk(source,followlinks=False):
            for name in [*dirs,*files]:
                path=Path(directory)/name;safe(path)
                archive.write(path,path.relative_to(source.parent))
    else:
        archive.write(source,source.name)
'''


@dataclass
class PackedArchive:
    file: Path
    dir: Path
    format: str
    passes: int
    root: Path

    @property
    def name(self):
        return self.file.name

    def cleanup(self):
        if not self.dir.exists():
            return
        # Never recursively delete a computed path until its ownership is checked.
        target,root = self.dir.resolve(),self.root.resolve()
        if target.parent != root or not target.name.startswith('koukou-archive-') or reparse(self.dir):
            raise ValueError('临时打包目录不在预期位置，停止清理')
        inspect_tree(target)
        shutil.rmtree(target)


class ArchivePacker:
    def __init__(self,*,seven_zip_path='',rar_path='',candidates=(),run_impl=run_archive):
        self.seven_zip_path = find_tool(seven_zip_path or os.environ.get('SEVEN_ZIP_PATH'),[*candidates,*DEFAULT_7Z],['7z.exe','7z','7zz'])
        self.rar_path = find_tool(rar_path or os.environ.get('RAR_PATH'),DEFAULT_RAR,['Rar.exe','rar'])
        self.run_impl = run_impl

    async def pack(self,source,*,format='zip',passes=1,out_dir=None,max_bytes=1024*1024*1024,current=lambda:True):
        source = local_source(source); inspect_tree(source)
        if not current():
            raise ValueError('打包请求已失效')
        fmt,times = normalize_format(format),normalize_passes(passes)
        raw_root = Path(out_dir or tempfile.gettempdir()).absolute()
        for part in [raw_root,*raw_root.parents]:
            if reparse(part):
                raise ValueError('临时打包目录不能经过链接')
        root = raw_root.resolve()
        if source.is_dir() and (root == source or source in root.parents):
            raise ValueError('临时打包目录不能位于源目录之内')
        root.mkdir(parents=True,exist_ok=True)
        directory = root/('koukou-archive-'+uuid.uuid4().hex); directory.mkdir()
        result = PackedArchive(source,directory,fmt,times,root)
        base = re.sub(r'[\\/:*?"<>|\x00-\x1f]','_',source.name).strip('. ')[:160] or 'archive'
        current_file = source
        try:
            for round_no in range(1,times+1):
                if not current():
                    raise ValueError('打包请求已失效')
                output = directory/(base+('' if round_no == 1 else f'.{round_no}')+'.'+fmt)
                operand = './'+current_file.name if current_file.name.startswith(('@','-')) else current_file.name
                if fmt == 'rar':
                    if not self.rar_path:
                        raise ValueError('没有找到 RAR 程序，请设置 RAR_PATH；7-Zip 不能创建 RAR')
                    command,args = self.rar_path,['a','-ma5','-m5','-y','-idq',str(output),'--',operand]
                elif self.seven_zip_path:
                    command,args = self.seven_zip_path,['a','-t'+fmt,'-mx=9','-y',str(output),'--',operand]
                elif fmt == '7z':
                    raise ValueError('没有找到 7-Zip，请设置 SEVEN_ZIP_PATH 或改用 zip')
                else:
                    command,args = sys.executable,['-X','utf8','-c',ZIP_WORKER,str(current_file),str(output)]
                await self.run_impl(command,args,cwd=current_file.parent,timeout=600)
                if not current():
                    raise ValueError('打包期间请求已失效，未上传')
                if reparse(output) or not output.is_file() or not 0 < output.stat().st_size <= max_bytes:
                    raise ValueError('压缩程序未生成有效文件，或结果超过上传上限')
                current_file = output
            result.file = current_file
            return result
        except BaseException:
            result.cleanup()
            raise
