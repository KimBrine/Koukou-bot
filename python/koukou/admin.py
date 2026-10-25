"""Native aiohttp control server, serving the existing HTML/CSS/JS frontend."""
import hmac
import asyncio
import json
import os
from pathlib import Path
import secrets
import time
import copy
import re
import uuid
from urllib.parse import urlsplit
from . import __version__
from .migration import report
from .state import read_json, write_json, write_text
from .commands import CommandRegistry
from .archive import stamp
from .sessions import Sessions, digest, persona_text
from .greetings import GreetingLibrary
from .backup import Backup
from .custom import CustomCommands, clean, render_reply
from .commands import split_request, normalize, RESERVED
from .quiet_greetings import QuietGreetings
from .summary_service import SummaryService
from .stickers import PersonaStickers, SCENES, image_mime
from .sticker_learn import suggest_metadata
from .media import MediaDelivery
from .messages import quiet_hour
from .providers import VisionProviders, PROVIDERS, REASONING_LEVELS, detect_models
from .context import build_chat_appendix
from .web_search import WebSearch
from .observability import Metrics, RuntimeStats, ErrorStore, NativeLogger, SelfCheck, configured_secrets, tail_log, today_stats
from .updates import UpdateChecker, local_version
from .image_hash import ImageHasher
from .protocol_management import LoginManagement
from .lifecycle import Lifecycle


class Admin:
    def __init__(self, config, plugins, memory, long_memory, *, onebot=None, model=None, sticker_tag_model=None, stickers=None, media_delivery=None):
        self.config, self.plugins, self.memory, self.long_memory = config, plugins, memory, long_memory
        self.onebot, self.model = onebot, model
        self.group_names, self.friend_names = {}, {}
        plugins.config = config
        self.commands = CommandRegistry(config, plugins)
        self.token = secrets.token_urlsafe(32)
        self.started = time.time()
        self.chat_file = config.data_dir / "chat-settings.json"
        self.settings = read_json(self.chat_file, {})
        self.sessions = Sessions(config, memory, long_memory, self.settings)
        self.greetings = GreetingLibrary(config.data_dir / "persona-greetings.json")
        self.backup = Backup(config)
        self.metrics = Metrics(config.data_dir/'metrics.json')
        self.runtime_stats = RuntimeStats()
        self.errors = ErrorStore(config.data_dir/'errors.json',secrets=lambda:configured_secrets(config))
        self.logger = NativeLogger(config.log_dir/'bot.log',errors=self.errors,metrics=self.metrics,secrets=lambda:configured_secrets(config))
        self.selfcheck = SelfCheck(config,onebot,self.backup)
        self.updates = UpdateChecker(root=config.root) if (config.root/'package.json').exists() else None
        self.custom = CustomCommands(config.data_dir / "custom-commands.json")
        self.vision_providers = VisionProviders(config)
        self.quiet_greetings = QuietGreetings(config, onebot, memory, self.settings, self.greetings) if onebot else None
        self.summaries = SummaryService(config, onebot, model, memory, self.settings) if onebot else None
        self.stickers = stickers or PersonaStickers(config, memory, self.settings)
        self.image_hasher = ImageHasher(config,logger=self.logger)
        self.sticker_tag_model = sticker_tag_model
        self.media = media_delivery or (MediaDelivery(config, onebot, plugins) if onebot else None)
        self.retag_job, self.background = None, set()
        self.watch = None
        self.login = LoginManagement(config,onebot) if onebot else None
        self.lifecycle = Lifecycle(config)
        self.schema = json.loads(Path(__file__).with_name("admin_schema.json").read_text(encoding="utf-8-sig"))
        self.gets = {
            "/api/state": self.state, "/api/config": self.get_config, "/api/python-scripts": self.get_plugins,
            "/api/chats": self.get_chats, "/api/memory": self.get_memory, "/api/longmemory": self.get_long,
            "/api/migration": self.get_migration,
            "/api/commands": self.get_commands, "/api/custom-commands": self.get_commands,
            "/api/personas": self.get_personas, "/api/memory-detail": self.memory_detail,
            "/api/memory-overview": self.memory_overview, "/api/memory-export": self.memory_export,
            "/api/poke-replies": self.get_poke_replies,
            "/api/backups": lambda _: {"items": self.backup.list(), "root": str(self.backup.root)},
            "/api/groups": self.get_groups, "/api/friends": self.get_friends,
            "/api/daily": self.get_daily,
            "/api/stickers": self.get_stickers, "/api/stickers/retag-status": self.retag_status,
            "/api/ping": lambda _: {'ok':True},
            "/api/vision-providers": lambda _: {'items':self.vision_providers.list()},
            "/api/models": self.get_models,
            "/api/tasks": self.get_tasks, "/api/websearch": self.get_websearch,
            "/api/metrics": lambda q: {'days':max(1,min(30,int(q.get('days') or 7))),'items':self.metrics.snapshot(max(1,min(30,int(q.get('days') or 7))))},
            "/api/errors": lambda _: {'items':self.errors.list()},
            "/api/logs": lambda q: {'bot':tail_log(config.log_dir/'bot.log',q.get('lines',200),q.get('filter',''),secrets=lambda:configured_secrets(config))},
            "/api/selfcheck": lambda _: self.selfcheck.run(),
            "/api/updates": self.get_updates,
        }
        self.actions = {
            "set-config": self.set_config, "set-config-batch": self.set_config_batch,
            "read-python-script": self.read_script, "import-python-script": self.import_script,
            "toggle-python-script": self.toggle_script, "delete-python-script": self.delete_script,
            "set-python-command": self.set_command, "save-python-settings": self.save_plugin_settings,
            "python-new-script": self.new_script,
            "save-builtin-command": self.save_builtin,
            "set-chat": self.set_chat, "reset-chat": self.reset_chat,
            "memory-update": self.memory_update, "memory-delete": self.memory_delete,
            "longmemory-update": self.long_update, "longmemory-pause": self.long_pause,
            "longmemory-resume": self.long_resume,
            "pending-delete": self.pending_delete, "memory-import": self.memory_import,
            "update-whitelist": self.update_whitelist, "add-private-whitelist": self.add_private,
            "get-persona": self.get_persona, "save-persona": self.save_persona,
            "create-persona": self.create_persona, "import-persona": self.import_persona,
            "delete-persona": self.delete_persona, "activate-persona": self.activate_persona,
            "export-persona": self.export_persona, "export-persona-package": self.export_persona_package,
            "get-greeting-library": self.get_greetings, "save-greeting-library": self.save_greetings,
            "save-poke-replies": self.save_poke_replies,
            "backup": lambda _: {"ok": True, **self.backup.run()},
            "restore-backup": lambda p: self.backup.queue_restore(p["name"]),
            "save-custom-command": self.save_custom, "delete-custom-command": self.delete_custom,
            "export-commands": self.export_commands, "preview-commands": self.preview_commands,
            "import-commands": self.import_commands,
            "send-morning-greetings": self.send_morning,
            "summary": self.summary, "summary-ack": self.summary_ack,
            "sticker-add": self.sticker_add, "sticker-update": self.sticker_update, "sticker-delete": self.sticker_delete,
            "sticker-blacklist": self.sticker_blacklist, "sticker-unblock": self.sticker_unblock,
            "sticker-suggest": self.sticker_suggest, "sticker-send": self.sticker_send, "retag-stickers": self.retag_stickers,
            "vision-provider-add": lambda p: {'ok':True,'item':self.vision_providers.add(p)},
            "vision-provider-update": lambda p: {'ok':True,'item':self.vision_providers.update(p['id'],p)},
            "vision-provider-delete": self.delete_vision_provider,
            "detect-models": self.detect_models, "detect-vision-models": self.detect_vision_models,
            "get-appendix": lambda _: {'text':build_chat_appendix()},
            "set-websearch": self.set_websearch,
            "generate-command": self.generate_command, "test-command": self.test_command,
            "draft-python-script": self.draft_plugin, "persona-check": self.persona_check,
            "clear-memory": self.clear_memory, "delete-chat": self.delete_chat,
            "cleanup-groups": self.cleanup_groups, "delete-backup": self.delete_backup,
            "check-poke": lambda _: {'ok':True,'enabled':self.commands.get('poke')['enabled'],'diagnostics':getattr(self,'poke_diagnostics',{}),'note':'请在QQ拍机器人头像；此处只检查事件，不发送测试消息。'},
            "watch-target": self.watch_target,
            "clear-errors": self.clear_errors,
            "check-update": self.check_update,
            "detect-similar": self.detect_similar,
            "daily-ping": self.send_daily_ping, "poke-target": self.poke_target,
            "id-check": self.id_check_members, "id-check-kick": self.id_check_kick,
            "qq-login-state": self.login_state, "qq-login-qrcode": self.login_qrcode,
            "qq-switch-account": self.login_switch, "qq-logout": self.login_logout,
            "restart-bot": lambda _: self.lifecycle.restart_bot(),
            "restart-napcat": lambda _: self.lifecycle.restart_protocol(),
            "open-python-folder": lambda _: self.lifecycle.open_folder(self.plugins.directory),
            "say": self.say,
        }

    async def say(self,p):
        if self.onebot is None or self.media is None:raise RuntimeError('当前预览禁止QQ发送')
        key,text=str(p.get('key') or ''),str(p.get('text') or '').strip()
        if not re.fullmatch(r'[gp]\d{1,15}',key) or not 1<=len(text)<=20000:raise ValueError('请选择有效会话并填写文字')
        account,session=self.onebot.self_id,self.onebot.timeline.session
        def active():
            raw=self.settings.get(key,{})
            spec=raw.get('quietHours') if raw.get('quietHours') is not None else self.config.get('QUIET_HOURS')
            return (account==self.onebot.self_id and session==self.onebot.timeline.session and self.onebot.status().get('online')
                    and raw.get('enabled') is not False and (not key.startswith('g') or int(key[1:]) not in self.config.ids('MUTED_GROUPS'))
                    and not (self.config.enabled('QUIET_HOURS_BLOCK_ALL') and quiet_hour(spec)))
        if not active():raise ValueError('目标会话已关闭、处于寂静时段，或QQ未确认在线')
        event={'user_id':int(key[1:]),'message_id':'console-say-'+uuid.uuid4().hex}
        if key.startswith('g'):event['group_id']=int(key[1:])
        receipts=await self.media.deliver(event,{'text':text},current=active)
        if not receipts:raise ValueError('发送结果未确认，请核对QQ，不会自动重发')
        self.memory.push(key,'assistant',text,messageId=receipts[0]['messageId'])
        return {'ok':True}

    async def login_state(self,_):
        return await self.login.state() if self.login else {'ok':True,'available':False,'provider':'','current':None,'accounts':[]}

    async def login_qrcode(self,_):
        if not self.login:raise RuntimeError('QQ登录管理在预览中已禁用')
        return await self.login.qrcode()

    async def login_switch(self,p):
        if not self.login:raise RuntimeError('QQ登录管理在预览中已禁用')
        return await self.login.switch(str(p.get('uin') or '').strip())

    async def login_logout(self,_):
        if not self.login:raise RuntimeError('QQ登录管理在预览中已禁用')
        return await self.login.logout()

    async def detect_similar(self,p):
        selected = self.selected_stickers(p)
        return await self.image_hasher.detect_similar(selected['store'],current=selected['current'])

    async def send_daily_ping(self,_):
        service = getattr(self,'daily_ping',None)
        if service is None: raise RuntimeError('定时指令模块未连接QQ')
        return {'ok':await service.send_now('控制台手动触发'),'config':service.describe()}

    async def poke_target(self,_):
        if not self.watch or not self.watch.enabled:
            return {'ok':False,'enabled':False,'note':'盯人回复未启用，请先在群会话设置中选择目标'}
        count = len(self.watch.pending)
        await self.watch.tick()
        return {'ok':True,'pendingBefore':count}

    def id_check_event(self,p):
        service = getattr(self,'id_check',None)
        if service is None: raise RuntimeError('群名片核对模块未连接QQ')
        group = int(p.get('groupId') or next(iter(sorted(self.config.ids('ID_CHECK_GROUPS'))),0))
        user = str(p.get('userId') or next(iter(sorted(self.config.ids('ID_CHECK_OPERATORS') | self.config.ids('ADMIN_USERS'))),''))
        if not group or p.get('dryRun') is False and not user.isdecimal(): raise ValueError('请指定群号与已配置操作员')
        return service,{'message_type':'group','group_id':group,'user_id':int(user or 0),'message_id':'console-id-'+uuid.uuid4().hex}

    async def id_check_members(self,p):
        service,event = self.id_check_event(p)
        if p.get('dryRun') is not False:
            result = await service.inspect(event['group_id'])
            return {'ok':True,'dryRun':True,'groupId':event['group_id'],'total':result['total'],'badCount':len(result['bad']),'list':result['bad'],'skipped':result['skipped']}
        result = await service.run_check(event)
        return {**result,'dryRun':False,'groupId':event['group_id'],'list':result.get('bad',[]),'badCount':len(result.get('bad',[]))}

    async def id_check_kick(self,p):
        service,event = self.id_check_event(p)
        if p.get('dryRun') is not False:
            return {'ok':True,'dryRun':True,'groupId':event['group_id'],'userId':str(event['user_id']),**await service.kick_status(event['group_id'],event['user_id'])}
        result = await service.run_kick(event)
        return {**result,'dryRun':False,'groupId':event['group_id'],'userId':str(event['user_id']),'kicked':len(result.get('confirmed',[]))}

    def clear_errors(self,_):
        self.errors.clear(); return {'ok':True}

    async def get_updates(self,_):
        if self.updates is None:
            return {'currentVersion':__version__,'available':False,'error':'当前目录没有已安装版本记录'}
        return await self.updates.check()

    async def check_update(self,_):
        if self.updates is None:
            raise ValueError('当前目录没有已安装版本记录，无法检查更新')
        return await self.updates.check(force=True)

    def get_tasks(self,_):
        backups = self.backup.list()
        return {'backup':{'last':backups[0]['at'] if backups else 0,'everyHours':6},
                'summary':{'enabled':self.config.enabled('SUMMARY_ENABLED'),'times':self.config.get('SUMMARY_TIMES','23:00')},
                'longMemory':{'enabled':self.config.enabled('LONG_MEMORY_ENABLED'),'everyMinutes':max(1,self.config.number('LONG_MEMORY_INTERVAL_MS',600000)/60000)},
                'stickersLearn':{'enabled':self.config.enabled('STICKER_LEARN_ENABLED',False),'perHour':self.config.number('STICKER_LEARN_PER_HOUR',6)}}

    def get_websearch(self,_):
        search = WebSearch.from_config(self.config)
        return {'enabled':bool(search),'model':self.config.get('WEB_SEARCH_MODEL','qwen-plus'),'provider':search.provider_name if search else 'off','configuredProvider':self.config.get('WEB_SEARCH_PROVIDER','auto')}

    def set_websearch(self,p):
        enabled = p.get('enabled') is not False
        model = str(p.get('model') or self.config.get('WEB_SEARCH_MODEL','qwen-plus')).strip()
        provider = str(p.get('provider') or ('bing' if model=='bing' else 'deepseek' if model=='deepseek' else 'dashscope')).lower()
        if provider not in {'auto','deepseek','dashscope','baidu','bing','off'} or not re.fullmatch(r'[A-Za-z0-9._:-]{1,64}',model):
            raise ValueError('搜索服务商或模型名无效')
        self.config.save({'WEB_SEARCH_ENABLED':'1' if enabled else '0','WEB_SEARCH_PROVIDER':provider,'WEB_SEARCH_MODEL':model})
        return {'ok':True,**self.get_websearch({})}

    async def generate_command(self,p):
        description = str(p.get('description') or '').strip()
        if not 1 <= len(description) <= 3000 or not self.model:
            raise ValueError('请填写3000字以内的描述并配置AI')
        raw = await self.model.chat('只生成一条可编辑指令草稿，返回JSON字段name,trigger,aliases,match,event,reply,description,aiPrompt。不要执行，不设置任何授权或启用开关。', [{'role':'user','content':description}],unlimited=True)
        match = re.search(r'\{[\s\S]*\}',raw)
        if not match: raise ValueError('AI没有返回有效指令草稿')
        data = json.loads(match[0])
        mode = 'ai' if p.get('mode')=='ai' else 'fixed'
        draft = clean({**data,'id':'draft','responseMode':mode,'enabled':False,'naturalLanguage':False,'scope':'all','adminOnly':False,'scheduleEnabled':False})
        draft['id']=''
        return {'ok':True,'draft':draft}

    def test_command(self,p):
        text = str(p.get('text') or '').strip()
        if not text: raise ValueError('请输入要测试的内容')
        event = {'user_id':p.get('userId') or next(iter(sorted(self.config.ids('ADMIN_USERS'))),0)}
        if p.get('isPrivate') is False: event['group_id']=int(p.get('groupId') or 0)
        plugin = self.commands.match_plugin(text)
        id = self.commands.detect(text) or (plugin[0]['id'] if plugin else None)
        item = self.commands.get(id) if id else None
        builtin = {'id':id,'name':item['name'],'enabled':item['enabled'],'allowed':self.commands.allowed(item,event),'trigger':item['trigger']} if item else None
        custom=[]
        for c in self.custom.all():
            for trigger in [c['trigger'],*c['aliases']]:
                if c['enabled'] and trigger and (text==trigger if c['match']=='exact' else trigger in text if c['match']=='contains' else text.startswith(trigger)):
                    custom.append({'id':c['id'],'name':c['name'],'trigger':trigger,'reply':render_reply(c['reply'],{'name':'测试用户','args':text[len(trigger):].strip()})[:500]}); break
        return {'builtin':builtin,'custom':custom}

    async def draft_plugin(self,p):
        description = str(p.get('prompt') or '').strip()
        if not 1 <= len(description) <= 3000 or not self.model:
            raise ValueError('请填写3000字以内的功能描述并配置AI')
        raw = await self.model.chat('为Koukou原生Python插件生成一个Python代码块，含# name/# desc/# usage/# admin元数据。用from koukou.plugin import plugin,Result，@plugin.command装饰handle(args:list[str])，末尾if __name__=="__main__": plugin.run()。返回Result(text=...,images=[...],files=[...])。所有指令用/具体指令，无需/py前缀。只用标准库；不执行shell、不读取密钥、不写OneBot调用，参数缺失说明用法。生成草稿不会运行或保存。', [{'role':'user','content':description}],unlimited=True)
        match = re.search(r'```(?:python|py)?\s*([\s\S]*?)```',raw,re.I)
        content = (match[1] if match else raw).strip()
        import ast
        ast.parse(content)
        warnings = [msg for pattern,msg in [(r'os\.system|subprocess|shutil\.rmtree|os\.remove','会执行命令或删除文件'),(r'eval\(|exec\(|__import__','使用动态执行'),(r'socket\.|requests\.|urllib\.request|http\.client','会发起网络请求'),(r'os\.environ|getenv','会读取环境变量')] if re.search(pattern,content)]
        return {'ok':True,'content':content,'filename':'new_'+str(int(time.time()))+'.py','warnings':warnings,'model':getattr(self.model,'model',''),'effort':'max'}

    def persona_check(self,_):
        text = self.config.persona().strip()
        warnings = [] if text else ['当前人格正文为空']
        for a,b in [('只认','好朋友'),('唯一的','朋友'),('主人','朋友'),('只能','也可以'),('禁止','可以')]:
            if a in text and b in text: warnings.append(f'同时出现「{a}」和「{b}」，可能自相矛盾')
        lines = [v.strip() for v in re.split(r'[。\n；]',text) if v.strip()]
        return {'length':len(text),'lines':len(lines),'warnings':warnings}

    def clear_memory(self,p):
        key,all = str(p.get('key') or ''),p.get('all') is True
        if not all and not re.fullmatch(r'[gp]\d{1,15}',key): raise ValueError('请选择需要清理的会话')
        def mutate():
            if all:
                self.memory.restore({'chats':{},'resetAt':int(time.time())*1000,'keyResetAt':{}}); self.long_memory.clear()
            else: self.memory.clear(key); self.long_memory.clear(key)
            return {'ok':True,'key':key,'all':all}
        result = self.sessions.transaction('控制台清理记忆',mutate)
        if self.watch: self.watch.reset_pending()
        return result

    def delete_chat(self,p):
        key = str(p.get('key') or '')
        if not re.fullmatch(r'[gp]\d{1,15}',key): raise ValueError('会话编号无效')
        # Back up reports and all user data before removing any conversation state.
        backup = self.backup.run(reason='删除会话前备份')
        def mutate():
            self.memory.clear(key); self.long_memory.clear(key); self.settings.pop(key,None)
            write_json(self.chat_file,self.settings)
            name = 'WHITELIST_GROUPS' if key[0]=='g' else 'PRIVATE_WHITELIST'
            ids = self.config.ids(name); removed = int(key[1:]) in ids; ids.discard(int(key[1:]))
            self.config.save({name:','.join(map(str,sorted(ids)))})
            return {'ok':True,'key':key,'whitelistRemoved':removed,'dailyBackup':backup['name']}
        result = self.sessions.transaction('删除会话',mutate)
        if self.watch: self.watch.reset_pending()
        return result

    def cleanup_groups(self,_):
        keys = set(self.settings)|set(self.memory.chats)|set(self.long_memory.chats)
        targets = sorted(k for k in keys if re.fullmatch(r'g\d{1,15}',k) and int(k[1:]) not in self.config.ids('WHITELIST_GROUPS'))
        results = [self.delete_chat({'key':key}) for key in targets]
        return {'ok':True,'removed':targets,'backup':results[0]['dailyBackup'] if results else None}

    def delete_backup(self,p):
        from .backup import NAME, remove
        name = str(p.get('name') or '')
        if not NAME.fullmatch(name): raise ValueError('备份名称无效')
        if (self.config.data_dir/'restore-pending.json').exists():
            raise ValueError('存在等待恢复的备份，请先完成恢复')
        remove(self.backup.root,name)
        return {'ok':True}

    def watch_target(self,p):
        key = str(p.get('key') or '')
        if not re.fullmatch(r'g\d{4,12}',key): raise ValueError('盯人目标只能是群会话')
        enabled = p.get('enabled') is not False
        uid = str(p.get('userId') or '').strip()
        if enabled and not re.fullmatch(r'\d{4,12}',uid): raise ValueError('请填写有效QQ号')
        self.config.save({'TARGET_WATCH_ENABLED':'1' if enabled else '0','TARGET_WATCH_GROUP':key[1:] if enabled else '', 'TARGET_WATCH_USER':uid if enabled else ''})
        state = self.watch.configure(enabled=enabled,group_id=key[1:] if enabled else '',user_id=uid if enabled else '') if self.watch else {'enabled':enabled,'groupId':key[1:] if enabled else '','userId':uid if enabled else ''}
        return {'ok':True,**state}

    def get_models(self, _):
        return {'providers':PROVIDERS,'levels':REASONING_LEVELS,'current':{
            'provider':self.config.get('MODEL_PROVIDER','deepseek'),'baseUrl':self.config.get('DEEPSEEK_BASE_URL','https://api.deepseek.com'),
            'model':self.config.get('DEEPSEEK_MODEL','deepseek-flash'),'reasoning':'max' if 'deepseek' in self.config.get('DEEPSEEK_MODEL','deepseek-flash').lower() else self.config.get('DEEPSEEK_REASONING_EFFORT'),
            'hasKey':bool(self.config.get('DEEPSEEK_API_KEY'))}}

    def delete_vision_provider(self,p):
        id = str(p.get('id',''))
        active = self.config.get('VISION_PROVIDER')
        first = (self.vision_providers.list() or [{}])[0].get('id')
        if active == 'custom:'+id or active == 'custom' and first == id:
            raise ValueError('请先切换到另一可用的识图服务，再删除当前接口')
        return {'ok':self.vision_providers.remove(id)}

    async def detect_models(self,p):
        return await detect_models(p.get('baseUrl') or self.config.get('DEEPSEEK_BASE_URL','https://api.deepseek.com'),p.get('apiKey') or self.config.get('DEEPSEEK_API_KEY'))

    async def detect_vision_models(self,p):
        provider = p.get('provider') or self.config.get('VISION_PROVIDER','deepseek')
        if provider == 'custom' or provider.startswith('custom:'):
            id = provider[7:] if provider.startswith('custom:') else (self.vision_providers.list() or [{}])[0].get('id')
            selected = self.vision_providers.get(id) or {}
            url,key = p.get('baseUrl') or selected.get('baseUrl',''),p.get('apiKey') or selected.get('apiKey','')
        else:
            prefix = 'DASHSCOPE' if provider=='dashscope' else 'DEEPSEEK'
            url,key = self.config.get(prefix+'_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1' if prefix=='DASHSCOPE' else 'https://api.deepseek.com'),self.config.get(prefix+'_API_KEY')
        if not key:
            raise ValueError('这个服务商还没有配置Key')
        return {**await detect_models(url,key),'provider':provider}

    async def state(self, _):
        stats = self.runtime_stats.snapshot()
        version = local_version(self.config.root) if self.updates is not None else __version__
        return {"now": time.time()*1000, "version": version + "-python-migration", "pid": os.getpid(),
                "uptimeSec": int(time.time()-self.started),
                "bot": {**(self.onebot.status() if self.onebot else {"connected": False, "online": False, "probeVerified": False, "selfId": ""}), "model": self.config.get("DEEPSEEK_MODEL", "deepseek-flash")},
                "config": {"whitelistGroups": sorted(self.config.ids("WHITELIST_GROUPS")),
                    "adminUsers": sorted(self.config.ids("ADMIN_USERS")), "quietHours": self.config.get("QUIET_HOURS"),
                    "proactiveRate": self.config.number("PROACTIVE_RATE", .04), "quietGreetings": self.quiet_greetings.status() if self.quiet_greetings else {"enabled": self.config.enabled('QUIET_GREETINGS_ENABLED', False), "blocked": True, "groups": []}},
                "today": today_stats(self.config.data_dir/'daily',self.memory), "summaryProgress": list(self.summaries.progress.items.values()) if self.summaries else [], "replies": self.runtime_stats.total_replied,
                "today_replies": stats['today_replies'], "counters": stats['counters'], "migration": self.get_migration({})}

    async def protocol_read(self, action):
        if self.onebot is None or not self.onebot.status().get('online'):
            raise RuntimeError('QQ实际在线状态尚未确认')
        session = self.onebot.timeline.session
        result = await self.onebot.api(action)
        if session != self.onebot.timeline.session or not self.onebot.status().get('online'):
            raise RuntimeError('读取期间QQ连接变化，请刷新')
        if not isinstance(result, list):
            raise ValueError('QQ返回的名单格式无效')
        return result

    async def get_groups(self, _):
        items = [{'id': str(v['group_id']), 'name': v.get('group_name', ''), **v} for v in await self.protocol_read('get_group_list') if isinstance(v, dict) and v.get('group_id')]
        self.group_names = {v['id']: v['name'] for v in items}
        return {'items': items}

    async def get_friends(self, _):
        items = [{'id': str(v['user_id']), 'name': v.get('remark') or v.get('nickname', ''), **v} for v in await self.protocol_read('get_friend_list') if isinstance(v, dict) and v.get('user_id')]
        self.friend_names = {v['id']: v['name'] for v in items}
        return {'items': items}

    async def send_morning(self, _):
        if self.quiet_greetings is None:
            raise RuntimeError('当前仅为控制台预览，QQ连接已禁用')
        return await self.quiet_greetings.catch_up_morning()

    async def summary(self, p):
        if self.summaries is None:
            raise RuntimeError('当前仅为控制台预览，QQ连接已禁用')
        if p.get('missingOnly'):
            if not self.summaries.schedule.enabled():
                raise ValueError('请先开启群总结漏发核验')
            groups = [p['groupId']] if p.get('groupId') else None
            task = asyncio.create_task(self.summaries.schedule.run_slot('23:30', early_fallback=True, group_ids=groups, stats_only=p.get('statsOnly') is True))
            self.background.add(task)
            def finished(value):
                self.background.discard(value)
                if not value.cancelled() and value.exception():self.logger.warning('手动补发核验未完成：%s',type(value.exception()).__name__)
            task.add_done_callback(finished)
            return {'ok':True,'missingOnly':True,'replacesFallback':True}
        group = p.get('groupId')
        return self.summaries.trigger([group] if group else None, days=max(1, min(30, int(p.get('days') or 1))), statistics=p.get('statsOnly') is True)

    def summary_ack(self, p):
        if self.summaries is None:
            raise RuntimeError('群总结服务未连接QQ')
        return {'ok': True, 'acknowledged': self.summaries.progress.acknowledge(p['groupId'], p['jobId']), 'progress': list(self.summaries.progress.items.values())}

    def get_daily(self, _):
        root, items = self.config.data_dir / 'daily', []
        if root.exists():
            for directory in root.iterdir():
                if directory.is_symlink() or not directory.is_dir() or not directory.name.isdecimal():
                    continue
                for file in sorted(directory.glob('*.jsonl'), reverse=True)[:14]:
                    if file.is_symlink() or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', file.stem):
                        continue
                    items.append({'groupId': directory.name, 'date': file.stem, 'size': file.stat().st_size})
        return {'items': items}

    def get_stickers(self, _):
        store = self.stickers.for_chat()
        learning = store.learning_status()
        return {'persona': self.stickers.scope(), 'items': store.list(), 'blacklist': store.blacklist_entries(), 'enabled': self.config.enabled('STICKERS_ENABLED'),
                'learned': sum(v['origin'] == 'learned' for v in store.items), 'scenes': SCENES,
                'learn': {**learning, 'enabled': self.config.enabled('STICKER_LEARN_ENABLED', False) and store.learning_allowed(), 'private': self.config.enabled('STICKER_LEARN_PRIVATE', False), 'perHour': self.config.number('STICKER_LEARN_PER_HOUR', 6), 'groups': sorted(self.config.ids('STICKER_LEARN_GROUPS'))},
                'settings': {'enabled': self.config.enabled('STICKERS_ENABLED'), 'autoRate': self.config.number('STICKER_AUTO_RATE', 35), 'maxPerReply': self.config.number('STICKER_MAX_PER_REPLY', 1), 'scope': self.config.get('STICKER_SEND_SCOPE', 'all'), 'groups': sorted(self.config.ids('STICKER_SEND_GROUPS')), 'pickMode': self.config.get('STICKER_PICK_MODE', 'context'), 'cooldownSeconds': self.config.number('STICKER_COOLDOWN_SECONDS', 0), 'webSearch': self.config.enabled('STICKER_WEB_SEARCH'), 'searchProvider': self.config.get('STICKER_SEARCH_PROVIDER', 'bing'), 'searchUrl': self.config.get('STICKER_SEARCH_URL'), 'searchKeyConfigured': bool(self.config.get('STICKER_SEARCH_KEY')), 'searchModel': self.config.get('STICKER_SEARCH_MODEL'), 'searchRewrite': self.config.enabled('STICKER_SEARCH_REWRITE'), 'searchFilter': self.config.enabled('STICKER_SEARCH_FILTER'), 'searchProxy': self.config.get('STICKER_SEARCH_PROXY')}}

    def selected_stickers(self, p):
        if p.get('stickerScope') != self.stickers.scope()['token']:
            raise ValueError('人格已变化，请刷新表情包页面后操作')
        return self.stickers.snapshot()

    def sticker_add(self, p):
        selected = self.selected_stickers(p)
        result = selected['store'].add(p)
        return {'ok': True, **result, 'count': len(selected['store'].items)}

    def sticker_update(self, p):
        item = self.selected_stickers(p)['store'].update(p['id'], p)
        if item is None:
            raise ValueError('找不到这张表情包')
        return {'ok': True, 'item': item}

    def sticker_delete(self, p):
        store = self.selected_stickers(p)['store']
        return {'ok': store.remove(p['id']), 'count': len(store.items)}

    def sticker_blacklist(self, p):
        store = self.selected_stickers(p)['store']
        if not store.blacklist(p['id']):
            raise ValueError('找不到这张表情包')
        return {'ok': True, 'count': len(store.items)}

    def sticker_unblock(self, p):
        if not self.selected_stickers(p)['store'].unblock(p['hash']):
            raise ValueError('找不到这条黑名单')
        return {'ok': True}

    async def sticker_suggest(self, p):
        selected = self.selected_stickers(p)
        draft = await suggest_metadata(p['dataUrl'], self.sticker_tag_model)
        if not selected['current']():
            raise ValueError('人格已变化，已丢弃旧人格补全结果')
        return {'ok': True, 'draft': draft}

    async def sticker_send(self, p):
        selected = self.selected_stickers(p)
        if self.onebot is None or self.media is None:
            raise RuntimeError('QQ连接已禁用，未发送表情包')
        group = str(p.get('groupId', ''))
        text = p.get('text', '')
        if not re.fullmatch(r'\d{5,12}', group) or not isinstance(text, str) or not 1 <= len(text.strip()) <= 1000:
            raise ValueError('请选择群并填写1~1000字伴随文字')
        if self.stickers.scope('g'+group)['key'] != selected['key']:
            raise ValueError('目标群使用另一个人格，请切换至对应人格图库')
        store = selected['store']
        item = store.get(p['id']) if p.get('id') else store.find(p.get('keyword', '')) or store.random()
        if item is None:
            raise ValueError('表情包库里没有符合条件的图')
        image = store.data_url(item)
        if not image:
            raise ValueError('表情包图片无法读取')
        account = self.onebot.self_id
        def active():
            settings = self.settings.get('g'+group, {})
            hours = settings.get('quietHours') if settings.get('quietHours') is not None else self.config.get('QUIET_HOURS')
            return self.onebot.self_id == account and self.onebot.status().get('online') and selected['current']() and store.data_url(item) is not None and settings.get('enabled') is not False and int(group) not in self.config.ids('MUTED_GROUPS') and not quiet_hour(hours)
        if not active():
            raise ValueError('当前目标群处于静谧时段、关闭状态或QQ未确认在线')
        event = {'group_id': int(group), 'user_id': account, 'message_id': 'console-sticker-'+str(uuid.uuid4())}
        receipts = await self.media.deliver(event, {'text': text.strip(), 'stickerImages': [image]}, current=active)
        if len(receipts) != 2:
            raise ValueError('表情包发送未确认，请先核对QQ，不自动重发')
        store.note_usage(item['id'], text)
        return {'ok': True, 'name': item['name']}

    def retag_status(self, q):
        return self.retag_job if self.retag_job and q.get('scope') == self.stickers.scope()['token'] == self.retag_job.get('scope') else {'running': False, 'done': 0, 'total': 0, 'errors': 0}

    def retag_stickers(self, p):
        selected = self.selected_stickers(p)
        if self.sticker_tag_model is None:
            raise ValueError('表情包第二轮识图模型未配置')
        if self.retag_job and self.retag_job['running']:
            raise ValueError('正在生成标签，请稍候')
        store, client = selected['store'], self.sticker_tag_model
        missing = p.get('onlyMissing') is True
        ids = p.get('ids')
        if ids is not None and not isinstance(ids, list):
            raise ValueError('表情包ID列表无效')
        fields = lambda item: {k: item.get(k) for k in ['id','hash','name','keywords','scenes','description']} if item else None
        items = [(v, stamp(fields(v))) for v in store.list() if (ids is None or v['id'] in ids) and (not missing or not v.get('description') or not v.get('keywords') or not v.get('name'))]
        job = {'running': True, 'done': 0, 'total': len(items), 'errors': 0, 'skipped': 0, 'startedAt': time.time()*1000, 'scope': selected['token']}
        self.retag_job = job
        async def run():
            try:
                for item, revision in items:
                    if not selected['current']():
                        job['cancelled'] = True; break
                    try:
                        if stamp(fields(store.get(item['id']))) != revision:
                            job['skipped'] += 1; continue
                        image = store.data_url(item)
                        if not image:
                            raise ValueError('图片已删除或拉黑')
                        draft = await suggest_metadata(image, client)
                        if not selected['current']():
                            job['cancelled'] = True; break
                        if stamp(fields(store.get(item['id']))) != revision:
                            job['skipped'] += 1; continue
                        patch = {k: draft[k] for k in ['name','keywords','description','scenes'] if not missing or not item.get(k)}
                        store.update(item['id'], patch)
                    except Exception as error:
                        job['errors'] += 1; job['lastError'] = str(error)[:200]
                    finally:
                        job['done'] += 1
            finally:
                job['running'] = False
        task = asyncio.create_task(run()); self.background.add(task); task.add_done_callback(self.background.discard)
        return {'ok': True, 'total': len(items)}

    def get_migration(self, _):
        return report(self.config.root, {*self.gets,'/api/sticker-file','/api/sticker-blacklist-file'}, self.actions)

    def get_config(self, _):
        return {"items": [{**field, "value": "" if field["type"] == "secret" else self.config.get(field["key"]),
                           "effective": "" if field["type"] == "secret" else self.config.get(field["key"]),
                           "configured": bool(self.config.get(field["key"])) if field["type"] == "secret" else None} for field in self.schema]}

    def get_plugins(self, _):
        return {"dir": str(self.plugins.directory), "items": self.plugins.list(), "settings": self.plugins.settings(), "nativeCommands": True}

    def get_commands(self, _):
        return {"items": self.custom.all(), "builtinItems": self.commands.all(), "nativeCommands": True}

    def validate_custom(self, item):
        for trigger in [item["trigger"], *item["aliases"]]:
            request = split_request(trigger)
            if request and (request[0] in RESERVED or any(request[0] in {normalize(p["command"]), normalize(p["pluginId"])} for p in self.commands.plugin_entries())):
                raise ValueError("触发词与已有内置或插件指令冲突")
        return item

    def save_custom(self, p):
        item = self.validate_custom(clean(p))
        return {"ok": True, "item": self.custom.upsert(item)}

    def delete_custom(self, p):
        self.custom.remove(p["id"])
        return {"ok": True}

    def export_commands(self, p):
        def redact(item):
            item = copy.deepcopy(item)
            if p.get("includeGroups") is not True:
                item.update(groups=[], scheduleGroups=[])
            return item
        id = p.get("id")
        commands = [redact(c) for c in self.custom.all() if not id or c["id"] == id]
        builtins = [redact(c) for c in self.commands.all() if not id or c["id"] == id]
        if id and not commands and not builtins:
            raise ValueError("指令不存在")
        return {"format": "koukou.commands", "version": 1, "commands": commands, "builtins": builtins}

    def preview_commands(self, p):
        text = p.get("content")
        if not isinstance(text, str) or len(text) > 262144:
            raise ValueError("指令文件须小于256KB")
        value = json.loads(text.removeprefix("\ufeff"))
        if not isinstance(value, dict) or value.get("format") != "koukou.commands" or value.get("version") != 1 or not isinstance(value.get("commands"), list) or not isinstance(value.get("builtins", []), list):
            raise ValueError("指令格式或版本不支持")
        if len(value["commands"]) > 200 or len(value.get("builtins", [])) > 200:
            raise ValueError("指令数量过多")
        commands = [self.validate_custom(clean({**c, "id": str(uuid.uuid4()), "enabled": False, "scheduleEnabled": False, "naturalLanguage": False})) for c in value["commands"] if isinstance(c, dict)]
        if len(commands) != len(value["commands"]):
            raise ValueError("指令条目格式错误")
        builtins = []
        for item in value.get("builtins", []):
            if not isinstance(item, dict) or not self.commands.get(item.get("id")):
                raise ValueError("包含尚未迁移或未知内置指令")
            builtins.append({k: item[k] for k in ["id", "scope", "groups", "adminOnly", "responseMode"] if k in item} | {"enabled": False})
        return {"commands": commands, "builtins": builtins}

    def import_commands(self, p):
        pack = self.preview_commands(p)
        def mutate():
            old = self.custom.all()
            names = {c["name"] for c in old}
            for item in pack["commands"]:
                base, n = item["name"], 2
                while item["name"] in names:
                    item["name"] = base[:28]+f"（导入{n}）"; n += 1
                names.add(item["name"])
            self.custom.replace(old+pack["commands"])
            if p.get("includeBuiltins") is True:
                for item in pack["builtins"]:
                    self.commands.save_builtin(item)
            return {"ok": True, "added": len(pack["commands"]), "builtins": len(pack["builtins"]) if p.get("includeBuiltins") is True else 0}
        return self.sessions.transaction("导入指令", mutate)

    def save_builtin(self, payload):
        return {"ok": True, "item": self.commands.save_builtin(payload)}

    def get_chats(self, _):
        keys = set(self.settings) | set(self.memory.chats) | {'g'+str(id) for id in self.config.ids('WHITELIST_GROUPS')} | {'p'+str(id) for id in self.config.ids('PRIVATE_WHITELIST') | self.config.ids('ADMIN_USERS')}
        items = []
        for key in sorted(keys):
            raw = self.settings.get(key, {})
            group, id = key.startswith('g'), key[1:]
            effective = {'enabled': True, 'atReplyEnabled': True, 'proactiveEnabled': True, **raw}
            for field, env, default in [('proactiveRate', 'PROACTIVE_RATE', .04), ('emojiKeepRate', 'EMOJI_KEEP_RATE', .35), ('replyMaxLines', 'REPLY_MAX_LINES', 3), ('lineMaxChars', 'REPLY_LINE_MAX_CHARS', 40)]:
                if effective.get(field) is None:
                    effective[field] = self.config.number(env, default)
            if effective.get('quietHours') is None:
                effective['quietHours'] = self.config.get('QUIET_HOURS')
            count = len(self.memory.get(key))
            items.append({'key': key, 'id': id, 'type': 'group' if group else 'private', 'name': raw.get('note') or (self.group_names if group else self.friend_names).get(id) or ('群 ' if group else 'QQ ')+id,
                          'inWhitelist': group and int(id) in self.config.ids('WHITELIST_GROUPS'), 'raw': raw, 'effective': effective, 'memory': count, 'memoryCount': count,
                          'privateAccess': None if group else {'listed': int(id) in self.config.ids('PRIVATE_WHITELIST'), 'admin': int(id) in self.config.ids('ADMIN_USERS'), 'configured': key in self.settings}, 'persona': raw.get('persona', '')})
        return {'items': items}

    def get_memory(self, q):
        return {"items": self.memory.get(q.get("key", ""))}

    def get_long(self, q):
        key = q.get("key", "")
        return {"key": key or None, "text": self.long_memory.text(key, q.get("q", "")[:500]) if key else ""}

    def memory_detail(self, q):
        key = q["key"]
        all = self.memory.get(key)
        record = self.long_memory.record(key)
        pending = record.get("pending", [])
        return {"key": key, "recent": all[-200:], "recentOffset": max(0, len(all)-200), "revision": stamp(all),
                "pendingRevision": stamp(pending), "longTerm": record.get("summary", ""), "updatedAt": record.get("updatedAt", 0),
                "pending": pending, "paused": record.get("paused", False), "running": key in self.long_memory.running}

    def memory_overview(self, _):
        keys = set(self.memory.chats) | set(self.long_memory.chats) | set(self.settings)
        items = [{"key": key, "recent": len(self.memory.get(key)), "longTermChars": len(self.long_memory.record(key).get("summary", "")),
                  "pending": len(self.long_memory.record(key).get("pending", []))} for key in keys]
        return {"persona": self.config.get("ACTIVE_PERSONA"), "items": sorted(items, key=lambda x: x["recent"]+x["longTermChars"], reverse=True)}

    def memory_export(self, _):
        return {"version": 1, "exportedAt": time.time()*1000, "persona": self.config.get("ACTIVE_PERSONA"),
                "memory": copy.deepcopy(self.memory.chats), "longMemory": copy.deepcopy(self.long_memory.chats)}

    def memory_import(self, p):
        data = p.get("data")
        if not isinstance(data, dict) or data.get("persona", self.config.get("ACTIVE_PERSONA")) != self.config.get("ACTIVE_PERSONA"):
            raise ValueError("导入格式无效或人格不同")
        mem, long = data.get("memory"), data.get("longMemory")
        if mem is None and long is None:
            raise ValueError("没有记忆可导入")
        from .memory import valid_key
        for collection, recent in [(mem, True), (long, False)]:
            if collection is None:
                continue
            if not isinstance(collection, dict):
                raise ValueError("记忆格式错误")
            for key, value in collection.items():
                valid_key(key)
                if recent:
                    valid = isinstance(value, list) and all(isinstance(e, dict) and e.get("role") in {"user", "assistant", "system"} and isinstance(e.get("content"), str) and isinstance(e.get("time", 0), (float, int)) for e in value)
                else:
                    valid = isinstance(value, dict) and isinstance(value.get("summary"), str) and isinstance(value.get("pending"), list) and all(isinstance(e, dict) and isinstance(e.get("text"), str) for e in value["pending"])
                if not valid:
                    raise ValueError("记忆条目格式错误")
        def mutate():
            if mem is not None:
                self.memory.restore({"chats": mem, "resetAt": 0, "keyResetAt": {}})
            if long is not None:
                self.long_memory.restore({"chats": long, "epoch": str(uuid.uuid4()), "keyEpochs": {}})
            return {"ok": True, "recentKeys": len(mem or {}), "longKeys": len(long or {})}
        return self.sessions.transaction("导入记忆", mutate)

    def update_whitelist(self, p):
        if p.get("operation") not in {"add", "remove"}:
            raise ValueError("不支持的白名单操作")
        return self.whitelist("WHITELIST_GROUPS", p.get("groupIds"), p["operation"])

    def add_private(self, p):
        return self.whitelist("PRIVATE_WHITELIST", p.get("userIds"), "add")

    def whitelist(self, name, values, operation):
        if not isinstance(values, list) or not 1 <= len(values) <= 200 or any(not re.fullmatch(r"[1-9]\d{4,11}", str(v).strip()) for v in values):
            raise ValueError("请输入1~200个有效的5~12位号码")
        old = self.config.ids(name); ids = set(map(int, values))
        next = old | ids if operation == "add" else old - ids
        self.config.save({name: ",".join(map(str, sorted(next)))})
        return {"ok": True, "changed": len(old ^ next), "whitelist": sorted(next)}

    def get_personas(self, _):
        return {"items": self.sessions.list(), "active": self.config.get("ACTIVE_PERSONA"), "dir": str(self.sessions.directory)}

    def get_persona(self, p):
        path = self.sessions.path(p["name"])
        return {"name": p["name"], "content": self.sessions.read(p["name"]) if path.exists() else ""}

    def save_persona(self, p):
        return self.sessions.save(p["name"], p.get("content"))

    def create_persona(self, p):
        return self.sessions.save(p["name"], p.get("content", "你是群里的一员。"), create=True)

    def import_persona(self, p):
        content = persona_text(p.get("content"))
        # Validate the library before creating a file; never overwrite an existing name.
        library = p.get("greetings")
        if library is not None:
            from .greetings import validate
            validate(library)
            if library.get("personaHash") != digest(content):
                raise ValueError("语库与人格不匹配")
        result = self.sessions.save(p["name"], content, create=True)
        if library is not None:
            self.greetings.set(content, library)
        return {**result, "name": p["name"]}

    def delete_persona(self, p):
        name = p["name"]
        if name == self.config.get("ACTIVE_PERSONA") or any(v.get("persona") == name for v in self.settings.values()):
            raise ValueError("请先切换正在使用此人格的会话")
        file = self.sessions.path(name)
        if file.exists():
            write_text(self.config.data_dir / "config-backups" / f"persona-delete-{uuid.uuid4()}.txt", file.read_text(encoding="utf-8-sig"))
            file.unlink()
        return {"ok": True}

    def activate_persona(self, p):
        return self.sessions.activate(p["name"])

    def export_persona(self, _):
        name = self.config.get("ACTIVE_PERSONA") or "默认人格"
        return {"name": name, "filename": f"Koukou-{name}-人格.txt", "content": self.config.persona()}

    def export_persona_package(self, p):
        name = p.get("name") or self.config.get("ACTIVE_PERSONA") or "默认人格"
        content = persona_text(p.get("content", self.config.persona()))
        bundle = {"format": "koukou-persona", "version": 1, "name": name, "content": content, "greetings": self.greetings.get(content)}
        return {"filename": "Koukou-人格.json", "content": json.dumps(bundle, ensure_ascii=False, indent=2)}

    def get_greetings(self, p):
        return {"library": self.greetings.get(p.get("content", self.config.persona()))}

    def save_greetings(self, p):
        return {"ok": True, "library": self.greetings.set(p["content"], p["library"])}

    def get_poke_replies(self, _):
        file = self.config.data_dir / "poke-replies.txt"
        return {"lines": [x.strip() for x in file.read_text(encoding="utf-8-sig").splitlines() if x.strip() and not x.strip().startswith("#")] if file.exists() else []}

    def save_poke_replies(self, p):
        text = p.get("text")
        if not isinstance(text, str):
            raise ValueError("语库必须是文本")
        lines = [x.strip() for x in text.splitlines() if x.strip() and not x.strip().startswith("#")]
        if not 1 <= len(lines) <= 300 or any(len(x) > 120 or "[CQ:" in x or "\0" in x for x in lines):
            raise ValueError("需要1~300句，每句最多120字纯文字")
        write_text(self.config.data_dir / "poke-replies.txt", "\n".join(lines)+"\n")
        return {"ok": True, "count": len(lines)}

    def set_config(self, p):
        return self.set_config_batch({"patch": {p["key"]: p.get("value", "")}})

    def set_config_batch(self, p):
        patch = p.get("patch", {})
        allowed = {field["key"]: field for field in self.schema}
        if not isinstance(patch, dict) or len(patch) > 80 or set(patch) - set(allowed):
            raise ValueError("配置项无效")
        # Preserve secret values on blank submissions, as the existing UI expects.
        clean = {key: str(value) for key, value in patch.items() if value != "" or allowed[key]["type"] != "secret"}
        learn_on = str(clean.get('STICKER_LEARN_ENABLED', '')).lower() in {'1','true','yes','on'}
        if learn_on and self.stickers.for_chat().learning_status()['full']:
            raise ValueError('当前人格图库已满60张，请先人工清理后重新开启学习')
        if "DEEPSEEK_REASONING_EFFORT" in clean and clean["DEEPSEEK_REASONING_EFFORT"] != "max":
            raise ValueError("Python版DeepSeek调用统一使用max")
        for key, value in clean.items():
            if allowed[key]["type"] in {"number", "rate"}:
                import math
                if not math.isfinite(float(value)):
                    raise ValueError("数值配置无效")
        self.config.save(clean)
        if learn_on:
            self.stickers.for_chat().resume_learning()
        live = sum(bool(allowed[key].get("live")) for key in clean)
        return {"ok": True, "changed": len(clean), "live": live, "needRestart": live < len(clean)}

    def read_script(self, p):
        return {"content": self.plugins.path(p["id"]).read_text(encoding="utf-8-sig")}

    def import_script(self, p):
        return {"ok": True, "item": self.plugins.import_script(p["filename"], p["content"], overwrite=True)}

    def new_script(self, p):
        return {"ok": True, "item": self.plugins.create(p["name"], p.get("description", "自定义指令"))}

    def toggle_script(self, p):
        return {"enabled": self.plugins.set_enabled(p["id"], p.get("enabled") is True)}

    def delete_script(self, p):
        self.plugins.path(p["id"]).unlink()
        return {"ok": True}

    def set_command(self, p):
        return {"ok": True, "command": self.plugins.set_command(p["id"], p.get("command", ""))}

    def save_plugin_settings(self, p):
        settings = self.plugins.settings()
        if "recallSeconds" in p:
            seconds = int(p["recallSeconds"])
            if not 5 <= seconds <= 7200:
                raise ValueError("撤回时间需在5~7200秒")
            settings["recallSeconds"] = seconds
        if "recallEnabled" in p:
            settings["recallEnabled"] = p["recallEnabled"] is True
        write_json(self.plugins.directory / "settings.json", settings)
        return {"ok": True, "settings": settings}

    def set_chat(self, p):
        return self.sessions.set(p["key"], p.get("patch", {}))

    def reset_chat(self, p):
        return self.sessions.set(p["key"], {}, remove=True)

    def memory_update(self, p):
        if p.get("revision") != stamp(self.memory.get(p["key"])):
            raise ValueError("记忆已更新，请刷新后编辑")
        if not isinstance(p.get("content"), str) or not p["content"].strip():
            raise ValueError("记忆内容不能为空")
        self.memory.edit(p["key"], p.get("idx", p.get("index")), p["content"])
        return {"ok": True}

    def memory_delete(self, p):
        if p.get("revision") != stamp(self.memory.get(p["key"])):
            raise ValueError("记忆已更新，请刷新后删除")
        self.memory.edit(p["key"], p.get("idx", p.get("index")), delete=True)
        return {"ok": True}

    def long_update(self, p):
        text = p.get("text", p.get("summary"))
        if not isinstance(text, str):
            raise ValueError("长期记忆需要文本")
        return {"ok": True, **self.long_memory.edit(p["key"], text, paused=True)}

    def pending_delete(self, p):
        record = copy.deepcopy(self.long_memory.record(p["key"]))
        pending = record.get("pending", [])
        index = p.get("index")
        if p.get("revision") != stamp(pending) or not isinstance(index, int) or not 0 <= index < len(pending):
            raise ValueError("待整理原文已更新，请刷新")
        self.long_memory.edit(p["key"], paused=record.get("paused", False))
        pending.pop(index)
        self.long_memory.chats[p["key"]]["pending"] = pending
        self.long_memory.save()
        return {"ok": True}

    def long_pause(self, p):
        return {"ok": True, **self.long_memory.edit(p["key"], paused=True)}

    def long_resume(self, p):
        return {"ok": True, **self.long_memory.edit(p["key"], paused=False)}

    def app(self):
        from aiohttp import web
        import inspect
        assets = self.config.root / "src" / "admin"

        async def dispatch(request):
            host = request.headers.get("Host", "")
            hostname = urlsplit("http://" + host).hostname
            if hostname not in {"127.0.0.1", "localhost", "::1"}:
                return web.json_response({"error": "Host无效"}, status=403)
            path = request.path
            if request.method == "GET" and path in {"/", "/index.html"}:
                source = (assets / "ui.html").read_text(encoding="utf-8-sig")
                banner = '<div style="padding:12px;background:#854d0e;color:white">'+('Python迁移预览：QQ和模型调用已禁用。' if self.onebot is None else 'Python后端验证实例；尚未切换main。')+'</div>'
                source = source.replace("<body>", "<body>" + banner + "<script>window.__ADMIN_TOKEN__=" + json.dumps(self.token) + "</script>")
                return web.Response(text=source, content_type="text/html")
            static = {"/ui.css": "ui.css", "/app.js": "app.js", "/command-center.js": "commandCenter.js", "/sticker-upload.js": "stickerUpload.js"}
            if request.method == "GET" and path in static:
                return web.FileResponse(assets / static[path])
            try:
                if request.method == "GET" and path in self.gets:
                    result = self.gets[path](dict(request.query))
                    return web.json_response(await result if inspect.isawaitable(result) else result)
                if request.method == 'GET' and path in {'/api/sticker-file','/api/sticker-blacklist-file'}:
                    if request.query.get('scope') != self.stickers.scope()['token']:
                        return web.Response(status=409, text='persona changed')
                    store = self.stickers.for_chat()
                    data = store.blacklist_image(request.query.get('hash', '')) if path.endswith('blacklist-file') else store.image(store.get(request.query.get('id', '')))
                    if data is None:
                        return web.Response(status=404, text='not found')
                    return web.Response(body=data, content_type=image_mime(data) or 'application/octet-stream', headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
                if request.method == "POST" and path.startswith("/api/"):
                    if not hmac.compare_digest(request.headers.get("X-Admin-Token", ""), self.token):
                        return web.json_response({"error": "未授权"}, status=401)
                    origin = request.headers.get("Origin")
                    if origin and origin != request.scheme + "://" + host:
                        return web.json_response({"error": "Origin无效"}, status=403)
                    if request.content_type != "application/json":
                        return web.json_response({"error": "仅支持application/json"}, status=415)
                    action = path.removeprefix("/api/action/") if path.startswith("/api/action/") else path.removeprefix("/api/")
                    if action not in self.actions:
                        return web.json_response({"error": "该接口尚未迁移到Python", "action": action}, status=501)
                    body = await request.json()
                    if not isinstance(body, dict):
                        raise ValueError("请求体必须为对象")
                    result = self.actions[action](body)
                    return web.json_response(await result if inspect.isawaitable(result) else result)
                return web.json_response({"error": "该接口尚未迁移到Python"}, status=501 if path.startswith("/api/") else 404)
            except (ValueError, SyntaxError, KeyError, OSError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            except RuntimeError as exc:
                return web.json_response({"error": str(exc)}, status=503)

        app = web.Application(client_max_size=16 * 1024 * 1024)
        app.router.add_route("*", "/{path:.*}", dispatch)
        async def cleanup(app):
            for task in list(self.background):
                task.cancel()
            await asyncio.gather(*list(self.background), return_exceptions=True)
            if self.summaries:
                await self.summaries.close()
            self.metrics.close()
            if self.updates: await self.updates.close()
        app.on_cleanup.append(cleanup)
        return app
