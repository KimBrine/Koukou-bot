"""Explicit native file/link commands; reuse plugin media delivery and its recall receipts."""
import asyncio
import json
from pathlib import Path
import re
import time
from urllib.parse import urlsplit
from .archive import stamp
from .packaging import ArchivePacker, PackedArchive, inspect_tree, local_source, reparse
from .scheduled import SendGuard
from .state import read_json, write_json
from .summary_jobs import receipt_id


class FileSendUncertain(RuntimeError):
    outcome_unknown = True

FILE = re.compile(r'^[/／]\s*发文件\s*(群|私聊)\s+(\d{5,15})\s+(.+?)\s*$',re.I)
LINK = re.compile(r'^[/／]\s*发链接\s*(群|私聊)\s+(\d{5,15})\s+(\S+)(?:\s+([\s\S]+))?\s*$',re.I)


def parse_file_command(text):
    text = str(text or '').strip()
    match = FILE.fullmatch(text)
    if match:
        return {'feature':'send-file','targetKey':('g' if match[1]=='群' else 'p')+str(int(match[2])),'path':match[3]}
    match = LINK.fullmatch(text)
    if match:
        return {'feature':'send-link','targetKey':('g' if match[1]=='群' else 'p')+str(int(match[2])),'url':match[3],'title':str(match[4] or match[3]).strip()}
    return None


def allowed_roots(config):
    value = config.get('FILE_SEND_ALLOWED_ROOTS').strip()
    if not value:
        return []
    raw = json.loads(value) if value.startswith('[') else re.split(r'[;\r\n]+',value)
    if not isinstance(raw,list) or any(not isinstance(p,str) or not p.strip() for p in raw):
        raise ValueError('可发送文件目录配置无效')
    return [local_source(path,root=config.root) for path in raw]


def file_identity(path):
    info = path.stat()
    return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns)


def valid_url(value):
    if not isinstance(value,str) or len(value)>4096 or any(c in value for c in '\r\n\0'):
        raise ValueError('链接无效')
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.port is not None and not 0 < parsed.port <= 65535:
            raise ValueError('链接必须是没有用户名密码的 HTTP(S) 地址')
    except ValueError as error:
        raise ValueError('链接必须是有效的 HTTP(S) 地址') from error
    return value


class FileCommands:
    def __init__(self,config,onebot,commands,media_delivery,settings,*,packer=None,authorize=None,now=time.time):
        self.config,self.onebot,self.commands,self.media,self.settings = config,onebot,commands,media_delivery,settings
        self.packer,self.authorize,self.now = packer,authorize,now
        self.guard = SendGuard(config,onebot,None,settings,now=now)
        self.temp_root = config.data_dir/'tmp'/'archives'
        self.temps_file = config.data_dir/'native-file-temp.json'
        self.temps = read_json(self.temps_file,{})
        self.links_file = config.data_dir/'native-link-delivery.json'
        self.links = read_json(self.links_file,{})
        if not isinstance(self.temps,dict) or not isinstance(self.links,dict) or any(not isinstance(v,dict) for v in [*self.temps.values(),*self.links.values()]):
            raise ValueError('文件投递状态损坏，停止自动处理')
        self.busy = set()

    def config_token(self):
        return stamp({key:self.config.get(key) for key in ['FILE_UPLOAD_MAX_MB','ARCHIVE_FORMAT','ARCHIVE_PASSES','SEVEN_ZIP_PATH','RAR_PATH','FILE_SEND_ALLOWED_ROOTS','QUIET_HOURS','MUTED_GROUPS']})

    def max_bytes(self):
        return max(1,self.config.number('FILE_UPLOAD_MAX_MB',1024))*1024*1024

    def permitted(self,event,request,rule):
        return bool(self.commands and self.commands.allowed(rule,event)) and (self.authorize is None or self.authorize(event,request) is True)

    def target_event(self,event,target):
        if target.startswith('g'):
            return {**event,'message_type':'group','group_id':int(target[1:])}
        return {k:v for k,v in {**event,'message_type':'private','user_id':int(target[1:])}.items() if k!='group_id'}

    def save_links(self):
        self.links = dict(list(self.links.items())[-4000:]); write_json(self.links_file,self.links)

    def own_temp(self,packed):
        root,target = self.temp_root.resolve(),packed.dir.resolve()
        if target.parent != root or reparse(packed.dir) or not target.name.startswith('koukou-archive-') or not packed.file.is_relative_to(target):
            raise ValueError('打包结果不在受控临时目录内')
        self.temps[str(target)] = {'file':str(packed.file),'format':packed.format,'passes':packed.passes,'createdAt':self.now(),'expiresAt':self.now()+86400}
        write_json(self.temps_file,self.temps)

    def remove_temp(self,packed):
        packed.cleanup(); self.temps.pop(str(packed.dir.resolve()),None); write_json(self.temps_file,self.temps)

    async def cleanup(self):
        """Only delete our verified temporary archives, never a user supplied source path."""
        for directory,entry in list(self.temps.items()):
            if entry.get('expiresAt',float('inf'))>self.now():
                continue
            packed = PackedArchive(Path(entry['file']),Path(directory),entry.get('format','zip'),entry.get('passes',1),self.temp_root)
            self.remove_temp(packed)

    async def handle(self,event,text,*,current=lambda:True):
        request = parse_file_command(text)
        if not request:
            return {'handled':False}
        if not 0 < int(request['targetKey'][1:]) <= 9007199254740991:
            return {'handled':True,'ok':False,'text':'发送目标号码无效。'}
        feature = request['feature']; rule = self.commands.get(feature) if self.commands else None
        if not self.permitted(event,request,rule):
            return {'handled':True,'ok':False,'text':'这个指令未启用，或你没有调用权限。'}
        origin = 'g'+str(event['group_id']) if event.get('group_id') else 'p'+str(event['user_id'])
        target = request['targetKey']; token = f"{self.onebot.self_id}:{origin}:{event.get('message_id')}:{target}:{feature}"
        if token in self.busy:
            return {'handled':True,'ok':False,'text':'本条发送请求正在处理。'}
        self.busy.add(token)
        try:
            origin_snapshot,target_snapshot = self.guard.snapshot(origin),self.guard.snapshot(target)
            config_token = self.config_token()
            def active():
                return current() and self.config_token() == config_token and self.commands.get(feature) == rule and self.permitted(event,request,rule) and self.guard.valid(origin,origin_snapshot) and self.guard.valid(target,target_snapshot)
            if not await self.guard.online(origin,origin_snapshot) or not active():
                return {'handled':True,'ok':False,'text':'当前会话暂停、处于寂静时段，或QQ未确认在线。'}
            if feature == 'send-link':
                return await self.send_link(token,request,active)
            return await self.send_file(event,request,active)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            return {'handled':True,'ok':False,'text':'发送未完成：'+str(error)[:300],'uncertain':bool(getattr(error,'outcome_unknown',False))}
        finally:
            self.busy.discard(token)

    async def send_file(self,event,request,active):
        admin = int(event['user_id']) in self.config.ids('ADMIN_USERS')
        roots = allowed_roots(self.config)
        if not admin and not roots:
            raise ValueError('非机器人管理员只能发送管理员明确开放目录中的文件')
        source = local_source(request['path'],root=self.config.root,roots=roots or None)
        if roots and not any(source == root or root in source.parents for root in roots):
            raise ValueError('文件不在管理员指定的可发送目录中')
        packed,retain = None,False
        try:
            path = source
            if source.is_dir():
                packer = self.packer or ArchivePacker(seven_zip_path=self.config.get('SEVEN_ZIP_PATH'),rar_path=self.config.get('RAR_PATH'))
                packed = await packer.pack(source,format=self.config.get('ARCHIVE_FORMAT','zip'),passes=self.config.number('ARCHIVE_PASSES',1),out_dir=self.temp_root,max_bytes=self.max_bytes(),current=active)
                self.own_temp(packed); path = packed.file
            if path.stat().st_size > self.max_bytes():
                raise ValueError(f'文件超过当前 {self.max_bytes()/1024/1024:g}MB 上传上限')
            signature = file_identity(path)
            def valid():
                try:
                    return active() and local_source(path) == path and file_identity(path) == signature
                except (ValueError,OSError):
                    return False
            if not valid():
                raise ValueError('文件或发送权限已变化，未上传')
            target = self.target_event(event,request['targetKey'])
            result = await self.media.deliver(target,{'files':[{'path':str(path),'name':path.name}]},current=valid)
            if not result:
                retain = packed is not None
                return {'handled':True,'ok':False,'uncertain':True,'text':'文件发送未取得新回执；请核对目标会话，未自动重发。'}
            label = f'打包文件：{path.name}（{packed.format}，压缩 {packed.passes} 次）' if packed else '文件：'+path.name
            return {'handled':True,'ok':True,'text':'已发送'+label,'receipts':result}
        except BaseException as error:
            # A timed-out provider may still be reading an owned archive. Keep it for one day.
            retain = packed is not None and (isinstance(error,asyncio.CancelledError) or getattr(error,'outcome_unknown',False) or isinstance(error,TimeoutError))
            raise
        finally:
            if packed and not retain:
                try:
                    self.remove_temp(packed)
                except (OSError,ValueError):
                    # Keep its durable cleanup record; cleanup failure cannot undo a receipt.
                    pass

    async def send_link(self,token,request,active):
        url,title = valid_url(request['url']),request['title'][:2000]
        if token in self.links:
            return {'handled':True,'ok':False,'uncertain':self.links[token].get('status')!='confirmed','text':'本条链接请求已有发送记录，请先核对目标会话。'}
        target = request['targetKey']
        async def dispatch(suffix,message):
            entry = {'status':'reserved','target':target,'selfId':str(self.onebot.self_id),'at':self.now()}
            self.links[token+suffix] = entry; self.save_links()
            if not active():
                entry['status']='skipped'; self.save_links(); return False
            returned = False
            try:
                result = await self.onebot.send(target,message)
                returned = True
                entry.update(status='confirmed',messageId=receipt_id(result)); self.save_links(); return True
            except BaseException as error:
                entry['status']='uncertain'
                try:
                    self.save_links()
                except Exception as persistence_error:
                    raise FileSendUncertain('发送回执无法保存，请核对目标会话，未自动重发') from persistence_error
                if returned and not getattr(error,'outcome_unknown',False):
                    raise FileSendUncertain('链接已调用QQ但回执未确认，请核对目标会话') from error
                raise
        try:
            ok = await dispatch('',[{'type':'share','data':{'url':url,'title':title,'content':title}}])
        except Exception as error:
            if getattr(error,'outcome_unknown',False) or not re.search(r'unsupported|not implemented|unknown.*(?:segment|type)|不支持.*(?:链接|卡片|share)',str(error),re.I):
                raise
            self.links[token]['status']='rejected'; self.save_links()
            if not active():
                return {'handled':True,'ok':False,'text':'发送条件已变化，未继续发送链接文字。'}
            ok = await dispatch(':text',title+' '+url)
        return {'handled':True,'ok':bool(ok),'text':'已发送链接：'+title if ok else '发送条件已变化，链接未发送。'}
