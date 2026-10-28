"""Configured protocol login adapters; importing or constructing never contacts QQ."""
import asyncio
import base64
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import quote, urlsplit
from .providers import base_url
from .onebot import OneBotError


class LoginAdapter:
    def __init__(self,config,*,session=None,request=None):
        self.config,self.session,self.request = config,session,request

    def llbot(self):
        c = self.config
        explicit = c.get('LLBOT_WEBUI_TOKEN_FILE')
        paths = [Path(explicit)] if explicit else []
        if paths and not paths[0].is_absolute(): paths[0]=c.env_file.parent/paths[0]
        paths += [c.data_dir.parent/'llbot/data/webui_token.txt',c.data_dir.parent.parent/'llbot/data/webui_token.txt',
                  c.root.parent/'llbot/data/webui_token.txt',c.root/'llbot/data/webui_token.txt',
                  c.root.parent/'luckylillia/bin/llbot/data/webui_token.txt']
        token,file = '', ''
        for path in paths:
            if path.is_file() and not path.is_symlink() and path.stat().st_size<=65536:
                token = path.read_text(encoding='utf-8-sig').strip()
                if token:
                    file=str(path);break
        return {'provider':'llbot','baseUrl':base_url(c.get('LLBOT_WEBUI_URL','http://127.0.0.1:3080')),'token':token,'tokenFile':file,'tried':list(dict.fromkeys(map(str,paths)))}

    def napcat(self):
        c = self.config
        url,token,file = c.get('NAPCAT_WEBUI_URL'),c.get('NAPCAT_WEBUI_TOKEN'),''
        directory = c.get('NAPCAT_DIR')
        if directory:
            path=Path(directory)
            if not path.is_absolute(): path=c.env_file.parent/path
            path=path/'config/webui.json'; file=str(path)
            if path.is_file() and not path.is_symlink() and path.stat().st_size<=65536:
                data=json.loads(path.read_text(encoding='utf-8-sig'))
                if not isinstance(data,dict):raise ValueError('NapCat WebUI配置无效')
                token=token or str(data.get('token') or '')
                host=str(data.get('host') or '127.0.0.1')
                if host in {'0.0.0.0','::'}:host='127.0.0.1'
                if ':' in host:host='['+host+']'
                port=int(data.get('port') or 6099)
                if not 0<port<=65535:raise ValueError('NapCat WebUI端口无效')
                url=url or f'http://{host}:{port}'
        return {'provider':'napcat','baseUrl':base_url(url) if url else '', 'token':token,'tokenFile':file,'tried':[file] if file else []}

    def selected(self):
        pref=self.config.get('LOGIN_PROVIDER','auto').lower()
        if pref=='llbot':return self.llbot()
        if pref=='napcat':return self.napcat()
        llbot=self.llbot()
        return llbot if llbot['token'] else self.napcat()

    def status(self):
        selected=self.selected()
        return {k:v for k,v in selected.items() if k!='token'}|{'available':bool(selected['token'] and selected['baseUrl'])}

    async def call(self,path,*,method='GET',body=None,selected=None):
        selected=selected or self.selected()
        if not selected['token'] or not selected['baseUrl']:
            raise ValueError('未配置协议端登录管理，请设置NapCat或LLBot的WebUI地址与凭据')
        token=selected['token']
        if re.search(r'[\r\n\x00]',token):raise ValueError('协议端凭据格式无效')
        headers={'Accept':'application/json'}
        url=selected['baseUrl']+path
        if selected['provider']=='llbot':headers['X-Webui-Token']=hashlib.sha256(token.encode()).hexdigest()
        else:
            headers['Authorization']='Bearer '+token
            url+='?token='+quote(token,safe='')
        if self.request:
            status,data=await self.request(url,method=method,headers=headers,body=body)
        else:
            import aiohttp
            own=self.session is None
            client=self.session or aiohttp.ClientSession(trust_env=False)
            try:
                async with client.request(method,url,json=body,headers=headers,allow_redirects=False,timeout=aiohttp.ClientTimeout(total=15)) as response:
                    chunks=bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        chunks.extend(chunk)
                        if len(chunks)>2*1024*1024:raise ValueError('协议端管理响应过大')
                    status,data=response.status,json.loads(chunks)
            except (aiohttp.ClientError,TimeoutError) as error:
                raise OneBotError('协议端登录管理请求未确认',action=path,outcome_unknown=method!='GET') from error
            finally:
                if own:await client.close()
        if not isinstance(data,dict) or not 200<=status<300:
            raise ValueError('协议端管理接口不可用：HTTP '+str(status))
        if selected['provider']=='llbot' and data.get('success') is False or selected['provider']=='napcat' and data.get('code',0)!=0:
            # Server text may echo credentials, so never forward it unfiltered.
            raise ValueError('协议端未确认该登录操作，请检查登录管理界面')
        return data.get('data')

    async def info(self,selected=None):
        selected=selected or self.selected()
        value=await self.call('/api/login-info' if selected['provider']=='llbot' else '/api/QQLogin/CheckLoginStatus',selected=selected)
        if not isinstance(value,dict) or value.get('isLogin') is False or not value.get('uin'):return None
        # LLBot login-info may omit both flags; a returned account is logged in.
        return {'uin':str(value['uin']),'nick':str(value.get('nick') or value.get('nickname') or ''),'online':value.get('online',value.get('isLogin',True)) is True}

    async def accounts(self,selected=None):
        selected=selected or self.selected()
        data=await self.call('/api/quick-login-list' if selected['provider']=='llbot' else '/api/QQLogin/GetQuickLoginList',method='GET' if selected['provider']=='llbot' else 'POST',selected=selected)
        rows=data if isinstance(data,list) else data.get('LocalLoginInfoList',data.get('list',[])) if isinstance(data,dict) else []
        return [{'uin':str(v.get('uin') or v.get('uid') or ''),'nick':str(v.get('nickName') or v.get('nick') or v.get('nickname') or v.get('name') or ''),'face':str(v.get('faceUrl') or v.get('face') or v.get('avatar') or '')} for v in rows if isinstance(v,dict)] if isinstance(rows,list) else []

    async def qrcode(self,selected=None):
        selected=selected or self.selected()
        data=await self.call('/api/login-qrcode' if selected['provider']=='llbot' else '/api/QQLogin/GetQQLoginQrcode',selected=selected)
        raw=str((data or {}).get('pngBase64QrcodeData') or (data or {}).get('qrcode') or (data or {}).get('url') or '')
        if not raw or len(raw)>2*1024*1024:raise ValueError('协议端没有返回有效登录二维码')
        if raw.startswith(('http://','https://')):
            url=urlsplit(raw)
            if not url.hostname or url.username or url.password or re.search(r'[\x00-\x20]',raw):
                raise ValueError('二维码地址无效')
            _=url.port  # Validate malformed ports while preserving ordinary query strings.
        elif raw.startswith('data:image/png;base64,'):
            base64.b64decode(raw.split(',',1)[1],validate=True)
        else:
            base64.b64decode(raw,validate=True);raw='data:image/png;base64,'+raw
        return {'image':raw,'expireAt':float((data or {}).get('expireTime') or 0)}

    async def logout(self,selected=None):
        selected=selected or self.selected()
        return await self.call('/api/logout' if selected['provider']=='llbot' else '/api/QQLogin/Logout',method='POST',selected=selected)

    async def quick_login(self,uin,selected=None):
        selected=selected or self.selected()
        return await self.call('/api/quick-login' if selected['provider']=='llbot' else '/api/QQLogin/SetQuickLogin',method='POST',body={'uin':str(uin)},selected=selected)


class LoginManagement:
    def __init__(self,config,onebot,*,adapter=None,pause=asyncio.sleep):
        self.config,self.onebot,self.adapter,self.pause=config,onebot,adapter or LoginAdapter(config),pause
        self.lock=asyncio.Lock()

    async def state(self):
        status=self.adapter.status()
        if not status['available']:return {'ok':True,**status,'current':None,'accounts':[]}
        selected=self.adapter.selected()
        current,accounts=await asyncio.gather(self.adapter.info(selected),self.adapter.accounts(selected),return_exceptions=True)
        current=current if isinstance(current,dict) else None
        accounts=accounts if isinstance(accounts,list) else []
        if current is None and self.onebot is not None:
            # The OneBot connection is authoritative for the live account; some
            # protocol WebUI versions reject the stored token, so fall back to it.
            health=self.onebot.status()
            if health.get('online') and health.get('selfId'):
                current={'uin':str(health['selfId']),'nick':'','online':True,'source':'onebot'}
                if not accounts:accounts=[current]
        return {'ok':True,**status,'current':current,'accounts':[{**v,'current':bool(current and v['uin']==current['uin'])} for v in accounts]}

    async def qrcode(self):return {'ok':True,**await self.adapter.qrcode()}

    async def logout(self):
        async with self.lock:
            if not self.adapter.status()['available']:raise ValueError('登录管理未配置')
            self.onebot.invalidate_account()
            await self.adapter.logout()
            return {'ok':True}

    async def switch(self,uin):
        if not re.fullmatch(r'\d{5,12}',str(uin)):raise ValueError('QQ号无效')
        async with self.lock:
            if not self.adapter.status()['available']:raise ValueError('登录管理未配置')
            selected=self.adapter.selected()
            account=object()  # An unreadable status is not proof that logout is unnecessary.
            if hasattr(self.adapter,'info'):
                try:account=await self.adapter.info(selected)
                except (ValueError,OneBotError,OSError):pass
            self.onebot.invalidate_account()
            if account is not None:await self.adapter.logout(selected)
            await self.adapter.quick_login(uin,selected)
            for _ in range(6):
                await self.pause(1.5)
                info=await self.adapter.info(selected)
                if info and info['online'] and info['uin']==str(uin):
                    return {'ok':True,'uin':str(uin),'nick':info['nick']}
            return {'ok':False,'needQr':True,'message':'快速登录未确认目标账号上线，请显示登录二维码后扫码'}
