"""Private vision endpoint registry and bounded OpenAI-compatible catalog reads."""
import copy
import json
import re
import uuid
from urllib.parse import urlsplit
from .state import read_json, write_json

PROVIDERS = [
    {'id':'deepseek','name':'DeepSeek','baseUrl':'https://api.deepseek.com','keyHint':'sk-…'},
    {'id':'dashscope','name':'通义千问（阿里云百炼）','baseUrl':'https://dashscope.aliyuncs.com/compatible-mode/v1','keyHint':'sk-…'},
    {'id':'openai','name':'OpenAI','baseUrl':'https://api.openai.com/v1','keyHint':'sk-…'},
    {'id':'moonshot','name':'月之暗面 Kimi','baseUrl':'https://api.moonshot.cn/v1','keyHint':'sk-…'},
    {'id':'zhipu','name':'智谱 GLM','baseUrl':'https://open.bigmodel.cn/api/paas/v4','keyHint':'…'},
    {'id':'custom','name':'自定义（任意 OpenAI 兼容接口）','baseUrl':'','keyHint':'按服务商要求填写'},
]
REASONING_LEVELS = [{'id':id,'name':name} for id,name in [('', '默认（不发送思考参数）'),('none','关闭思考（DeepSeek）'),('low','低（少量思考）'),('high','高（思考更多）'),('max','最高（最慢最贵）')]]


def base_url(raw):
    value = str(raw or '').strip().rstrip('/')
    try:
        parsed = urlsplit(value)
        valid = parsed.scheme in {'http','https'} and parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
        parsed.port
    except ValueError:
        valid = False
    if not valid or re.search(r'[\x00-\x20\x7f]', value):
        raise ValueError('接口地址须为不含凭据、参数的HTTP或HTTPS地址')
    return value


class VisionProviders:
    def __init__(self, config):
        self.file = config.data_dir/'vision-providers.json'
        raw = read_json(self.file, [])
        if not isinstance(raw,list):
            raise ValueError('自定义识图配置读取失败，请恢复私有备份后重试')
        self.items = []
        for item in raw:
            if not isinstance(item,dict) or not re.fullmatch(r'vp_[A-Za-z0-9_-]{1,60}',str(item.get('id',''))):
                raise ValueError('自定义识图条目损坏')
            self.items.append({**item,'baseUrl':base_url(item.get('baseUrl'))})
        if len({v['id'] for v in self.items}) != len(self.items):
            raise ValueError('自定义识图标识冲突')
        if not self.file.exists() and config.get('VISION_CUSTOM_BASE_URL') and config.get('VISION_CUSTOM_API_KEY'):
            self.add({'name':'默认自定义','baseUrl':config.get('VISION_CUSTOM_BASE_URL'),'apiKey':config.get('VISION_CUSTOM_API_KEY'),'model':config.get('VISION_CUSTOM_MODEL')})

    def commit(self, items):
        write_json(self.file,items)
        self.items = items

    def list(self):
        return [{k:item.get(k,'') for k in ('id','name','baseUrl','model')} | {'hasKey':bool(item.get('apiKey')),'keyHint':'••••'+str(item['apiKey'])[-4:] if item.get('apiKey') else ''} for item in self.items]

    def get(self,id):
        return copy.deepcopy(next((v for v in self.items if v['id']==id),None))

    def add(self,p):
        key = str(p.get('apiKey') or '').strip()
        if not key or re.search(r'[\r\n\x00]',key):
            raise ValueError('请填写有效API Key')
        item = {'id':'vp_'+uuid.uuid4().hex[:8],'name':str(p.get('name') or '自定义识图').strip()[:30],
                'baseUrl':base_url(p.get('baseUrl')),'apiKey':key,'model':str(p.get('model') or '').strip()}
        self.commit([*self.items,item])
        return next(v for v in self.list() if v['id']==item['id'])

    def update(self,id,p):
        item = self.get(id)
        if not item:
            raise ValueError('找不到这个自定义接口')
        if 'baseUrl' in p:
            item['baseUrl'] = base_url(p['baseUrl'])
        for field in ('name','model'):
            if field in p:
                item[field] = str(p[field]).strip()[:30 if field=='name' else 200] or item.get(field,'')
        if p.get('apiKey'):
            if re.search(r'[\r\n\x00]',str(p['apiKey'])):
                raise ValueError('API Key格式无效')
            item['apiKey'] = str(p['apiKey']).strip()
        self.commit([item if v['id']==id else v for v in self.items])
        return next(v for v in self.list() if v['id']==id)

    def remove(self,id):
        if not self.get(id): return False
        self.commit([v for v in self.items if v['id']!=id]); return True


async def detect_models(url, key='', *, session=None, timeout=20):
    """Administrator-selected endpoints may be local; never follow auth redirects."""
    import aiohttp
    target = base_url(url)+'/models'
    if re.search(r'[\r\n\x00]',str(key)):
        raise ValueError('API Key格式无效')
    own = session is None
    client = session or aiohttp.ClientSession(trust_env=True)
    try:
        async with client.get(target,headers={'Accept':'application/json',**({'Authorization':'Bearer '+key} if key else {})},
                              timeout=aiohttp.ClientTimeout(total=max(2,timeout)),allow_redirects=False) as response:
            if response.status in {401,403}:
                raise ValueError('密钥无效或没有权限（401/403）')
            if not 200 <= response.status < 300:
                raise ValueError('服务商返回HTTP '+str(response.status))
            data = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                data.extend(chunk)
                if len(data)>2*1024*1024:
                    raise ValueError('模型目录响应过大')
            value = json.loads(data)
        raw = value.get('data',value.get('models',[])) if isinstance(value,dict) else []
        models = sorted([{'id':str(v.get('id') or v.get('name') or v.get('model') or '').strip(), 'ownedBy':str(v.get('owned_by') or v.get('ownedBy') or '')} for v in raw if isinstance(v,dict)],key=lambda v:v['id']) if isinstance(raw,list) else []
        models = [v for v in models if v['id']]
        if not models:
            raise ValueError('接口有响应，但没有返回模型目录')
        return {'ok':True,'url':target,'count':len(models),'models':models}
    except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError) as exc:
        raise ValueError('模型目录检测失败，请检查网络、接口地址与密钥') from exc
    finally:
        if own: await client.close()
