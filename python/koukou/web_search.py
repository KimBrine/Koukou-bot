"""Native text search providers, bounded cache, and complete model tool-call flow."""
import base64
from collections import OrderedDict
import copy
import html
import json
import logging
import re
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from .http_client import request
from .image_search import safe_diagnostic
from .models import clean_reply

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
DASHSCOPE_NATIVE = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation'
SEARCH_TOOLS = [{'type': 'function', 'function': {'name': 'web_search',
    'description': '联网搜索工具。只有当需要最新信息、实时数据、新闻事件、价格行情、事实核查时才调用（例如询问今天/最近/现在的事情）。日常闲聊、寒暄、接梗不需要调用。',
    'parameters': {'type': 'object', 'properties': {'query': {'type': 'string', 'description': '搜索关键词'}}, 'required': ['query']}}}]


def strip_tags(value):
    value = re.sub(r'<script[\s\S]*?</script>|<style[\s\S]*?</style>', ' ', str(value or ''), flags=re.I)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', value))).strip()


def decode_bing_url(href):
    try:
        url = urljoin('https://cn.bing.com', str(href or ''))
        parts = urlsplit(url)
        if not re.search(r'/ck/a', parts.path):
            return url
        raw = parse_qs(parts.query).get('u', [''])[0]
        if not raw.startswith('a1'):
            return url
        encoded = raw[2:]
        decoded = base64.urlsafe_b64decode(encoded+'='*((-len(encoded)) % 4)).decode('utf-8')
        return decoded if re.match(r'https?://', decoded, re.I) else url
    except (ValueError, TypeError, UnicodeError):
        return str(href or '')


def parse_bing_results(document):
    out, seen = [], set()
    for block in re.split(r'<li class="b_algo"', str(document or ''), flags=re.I)[1:]:
        head = re.search(r'<h2[^>]*>[\s\S]*?<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)</a>', block, re.I)
        if not head:
            continue
        title, url = strip_tags(head[2]), decode_bing_url(html.unescape(head[1]))
        if not title or not re.match(r'https?://', url, re.I) or url in seen:
            continue
        para = re.search(r'<p[^>]*>([\s\S]*?)</p>', block, re.I)
        seen.add(url)
        out.append({'title': title, 'url': url, 'date': '', 'snippet': strip_tags(para[1])[:300] if para else ''})
        if len(out) >= 6:
            break
    return out


def refs_summary(refs):
    return '\n\n'.join('['+str(i+1)+'] '+str(item.get('title') or '')+('（'+str(item['date'])+'）' if item.get('date') else '')+'\n'+str(item.get('snippet') or '')+'\n'+str(item.get('url') or '') for i, item in enumerate(refs))


class WebSearch:
    """One selected provider, with JS-compatible auto priority and 10 minute cache."""
    def __init__(self, *, provider='auto', api_key='', dashscope_api_key='', deepseek_api_key='',
                 dashscope_model='qwen-plus', base_url='https://qianfan.baidubce.com/v2/ai_search',
                 bing_host='https://cn.bing.com', timeout=20, fetch=request, now=time.monotonic,
                 dashscope_url=DASHSCOPE_NATIVE, deepseek_url='https://api.deepseek.com/v1/tools/search'):
        mode = str(provider or 'auto').strip().lower()
        if mode == 'auto':
            mode = 'baidu' if api_key else 'deepseek' if deepseek_api_key else 'dashscope' if dashscope_api_key else 'bing'
        if mode not in {'off', 'baidu', 'deepseek', 'dashscope', 'bing'}:
            raise ValueError('联网搜索服务商无效')
        if mode in {'baidu', 'deepseek', 'dashscope'} and not {'baidu': api_key, 'deepseek': deepseek_api_key, 'dashscope': dashscope_api_key}[mode]:
            raise ValueError({'baidu': '千帆', 'deepseek': 'DeepSeek', 'dashscope': '通义'}[mode]+'搜索尚未配置 Key')
        self.provider_name, self.is_enabled = mode, mode != 'off'
        self.api_key, self.dashscope_api_key, self.deepseek_api_key = api_key, dashscope_api_key, deepseek_api_key
        self.dashscope_model, self.base_url, self.bing_host = dashscope_model, base_url.rstrip('/'), bing_host.rstrip('/')
        self.timeout, self.fetch, self.now = timeout, fetch, now
        self.dashscope_url, self.deepseek_url = dashscope_url, deepseek_url
        self.cache = OrderedDict()

    @classmethod
    def from_config(cls, config, **options):
        get = config.get
        on = str(get('WEB_SEARCH_ENABLED', '1')).lower().strip() not in {'0', 'false', 'off', 'no'}
        provider = str(get('WEB_SEARCH_PROVIDER', 'auto')).lower().strip()
        if not on or provider == 'off':
            return None
        return cls(provider=provider, api_key=str(get('BAIDU_QIANFAN_API_KEY', '')).strip(),
                   dashscope_api_key=str(get('DASHSCOPE_API_KEY', '')).strip(), deepseek_api_key=str(get('DEEPSEEK_API_KEY', '')).strip(),
                   dashscope_model=str(get('WEB_SEARCH_MODEL', 'qwen-plus')).strip() or 'qwen-plus', **options)

    async def __call__(self, query):
        if not self.is_enabled:
            raise ValueError('联网搜索已关闭')
        query = str(query or '').strip()[:400]
        if not query:
            return {'summary': '', 'refs': []}
        hit = self.cache.get(query)
        if hit and self.now()-hit[0] <= 600:
            return copy.deepcopy(hit[1])
        if hit:
            del self.cache[query]
        value = await getattr(self, 'search_'+self.provider_name)(query)
        self.cache[query] = (self.now(), copy.deepcopy(value))
        while len(self.cache) > 50:
            self.cache.popitem(last=False)
        return value

    async def post(self, url, key, payload, provider):
        response = await self.fetch(url, method='POST', payload=payload,
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer '+key},
            maximum=2*1024*1024, timeout=self.timeout, configured=True)
        if not response.ok:
            raise ValueError(f'{provider}搜索 HTTP {response.status}')
        try:
            data = response.json()
        except ValueError:
            raise ValueError(provider+'搜索没有返回有效JSON') from None
        if not isinstance(data, dict):
            raise ValueError(provider+'搜索响应格式无效')
        return data

    async def search_dashscope(self, query):
        payload = {
            'model': self.dashscope_model, 'input': {'messages': [{'role': 'user', 'content': query[:400]}]},
            'parameters': {'enable_search': True, 'search_options': {'forced_search': True, 'search_strategy': 'turbo', 'enable_source': True, 'enable_citation': True}, 'result_format': 'message', 'max_tokens': 800}}
        if self.dashscope_model.lower().startswith('deepseek'):
            payload['parameters']['reasoning_effort'] = 'max'
        data = await self.post(self.dashscope_url, self.dashscope_api_key, payload, '通义')
        output = data.get('output') or {}
        choices = output.get('choices') or []
        text = str((choices[0].get('message') or {}).get('content') or '').strip() if choices else ''
        if not text:
            raise ValueError('通义搜索没有返回内容')
        refs = [{'title': item.get('title') or '', 'url': item['url'], 'date': item.get('date') or '', 'snippet': item.get('snippet') or ''}
                for item in ((output.get('search_info') or {}).get('search_results') or [])[:6]
                if isinstance(item, dict) and re.match(r'https?://', str(item.get('url') or ''), re.I)]
        return {'summary': text+('\n\n搜索来源：\n'+refs_summary(refs) if refs else ''), 'refs': refs, 'provider': 'dashscope'}

    async def search_deepseek(self, query):
        data = await self.post(self.deepseek_url, self.deepseek_api_key, {'query': query[:128], 'count': 5, 'ori_question': query[:128]}, 'DeepSeek')
        refs = [{'title': item.get('title') or '', 'url': item.get('url') or '', 'date': item.get('date') or '', 'snippet': str(item.get('summary') or item.get('snippet') or '')[:500]}
                for item in (data.get('results') or [])[:5] if isinstance(item, dict)]
        if not refs:
            raise ValueError('DeepSeek 没有搜到结果')
        return {'summary': refs_summary(refs), 'refs': refs, 'provider': 'deepseek'}

    async def search_baidu(self, query):
        data = await self.post(self.base_url+'/web_search', self.api_key, {'messages': [{'role': 'user', 'content': query[:400]}], 'search_strategy': 'speed', 'stream': False}, '百度')
        refs = [{'title': item.get('title') or '', 'url': item.get('url') or '', 'date': item.get('date') or '', 'snippet': str(item.get('content') or item.get('snippet') or '')[:300]}
                for item in (data.get('references') or [])[:6] if isinstance(item, dict)]
        text = data.get('content')
        summary = text.strip() if isinstance(text, str) and text.strip() else refs_summary(refs)
        return {'summary': summary, 'refs': refs, 'provider': 'baidu'}

    async def search_bing(self, query):
        last_error = None
        for host in dict.fromkeys([self.bing_host, 'https://www.bing.com']):
            try:
                response = await self.fetch(host+'/search?'+urlencode({'q': query[:400], 'setlang': 'zh-CN', 'ensearch': 0}),
                    headers={'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', 'accept': 'text/html'}, maximum=2*1024*1024,
                    timeout=self.timeout, configured=host not in {'https://cn.bing.com', 'https://www.bing.com'})
                if not response.ok:
                    raise ValueError(f'必应搜索 HTTP {response.status}')
                refs = parse_bing_results(response.text())
                if not refs:
                    raise ValueError('必应没有解析到结果')
                return {'summary': refs_summary(refs), 'refs': refs, 'provider': 'bing'}
            except Exception as exc:
                last_error = ValueError(safe_diagnostic(exc))
        raise last_error or ValueError('必应搜索失败')


def create_web_search(**options):
    return None if str(options.get('provider', 'auto')).strip().lower() == 'off' else WebSearch(**options)


def _answer(message):
    content = message.get('content')
    return clean_reply(content) if isinstance(content, str) else ''


async def generate_with_search(llm, web_search, system, history, content, *, current=lambda: True, logger=None, metrics=None):
    """Finish every tool call, preserve reasoning, then block leaked tool drafts.

    The caller applies permissions and image/direct-reply gates before choosing this
    path. No message is sent here. ModelClient retains max reasoning on every call.
    """
    logger = logger or logging.getLogger('koukou.web-search')
    def check():
        if not current():
            raise ValueError('联网搜索请求已失效')
    messages = [*copy.deepcopy(history), {'role': 'user', 'content': content}]
    check()
    first = await llm.raw(system, messages, tools=SEARCH_TOOLS, unlimited=True)
    check()
    calls = first.get('tool_calls') or []
    if not calls:
        answer = _answer(first)
        if answer:
            return answer
        # Protocol-looking drafts are never retried as if they were a normal reply.
        if first.get('content'):
            raise ValueError('联网搜索回答包含工具协议，已拦截')
        result = await llm.chat(system, messages, unlimited=True)
        check()
        return clean_reply(result)
    answers = []
    for call in calls:
        check()
        function = call.get('function') or {}
        if len(answers) >= 2:
            text = '本轮搜索次数已达上限，请根据已有结果作答。'
        elif function.get('name') != 'web_search':
            text = '此工具不可用，请根据已有资料作答。'
        else:
            try:
                query = json.loads(function.get('arguments') or '{}').get('query')
                query = query.strip()[:400] if isinstance(query, str) else ''
            except (ValueError, TypeError, AttributeError):
                query = ''
            if not query:
                text = '（这次调用没有给搜索关键词）'
            else:
                try:
                    result = await web_search(query)
                    check()
                    if metrics and callable(getattr(metrics, 'search', None)):
                        metrics.search()
                    text = str(result.get('summary') or '')[:3000]
                    logger.info('联网搜索已完成')
                except Exception as exc:
                    check()
                    text = '搜索失败：'+safe_diagnostic(exc)
                    logger.warning('联网搜索失败：%s', safe_diagnostic(exc))
        answers.append({'role': 'tool', 'tool_call_id': call.get('id', ''), 'content': text})
    # Keep native reasoning_content, including an empty string required by some APIs.
    assistant = {'role': 'assistant', 'content': first.get('content') or '', 'tool_calls': calls}
    if 'reasoning_content' in first:
        assistant['reasoning_content'] = first['reasoning_content']
    messages.extend([assistant, *answers])
    check()
    second = await llm.raw(system, messages, unlimited=True)
    check()
    if second.get('tool_calls') or not _answer(second):
        logger.warning('联网搜索最终回答含工具协议或没有正文，保留搜索结果重生成一次')
        second = await llm.raw(system, [*messages, {'role': 'user', 'content': '搜索阶段已经结束，请只根据上面的真实搜索结果回答原问题；结果不足就明确说明，不要继续调用工具，不要输出DSML、工具参数或调用格式，只输出给用户看的自然语言正文。'}], unlimited=True)
        check()
    answer = _answer(second)
    if second.get('tool_calls') or not answer:
        raise ValueError('搜索结果回答连续输出工具协议或没有正文，已拦截')
    return answer
