"""Native image search providers and bounded, validated candidate downloads.

This module only returns candidates. It never sends QQ messages or admits images to
a sticker library. All network operations accept an injected async ``fetch`` for
offline fixtures; the normal transport blocks private image destinations.
"""
import asyncio
import base64
import hashlib
import html
import json
import re
import struct
from urllib.parse import quote, urlencode, urlsplit
from .http_client import request

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
MAX_BYTES = 4*1024*1024


class StaleStickerRequest(ValueError):
    code = 'STALE_STICKER_REQUEST'

    def __init__(self):
        super().__init__('请求已失效，取消联网找图')


def check_current(current):
    if not current():
        raise StaleStickerRequest()


def sniff_mime(buffer):
    if not buffer or len(buffer) < 12:
        return ''
    if buffer[:4] == b'\x89PNG':
        return 'image/png'
    if buffer[:2] == b'\xff\xd8':
        return 'image/jpeg'
    if buffer[:3] == b'GIF':
        return 'image/gif'
    if buffer[:4] == b'RIFF' and buffer[8:12] == b'WEBP':
        return 'image/webp'
    return ''


def image_size(buffer):
    try:
        if len(buffer) > 24 and buffer[:2] == b'\x89P':
            width, height = struct.unpack('>II', buffer[16:24])
            return {'width': width, 'height': height}
        if len(buffer) > 10 and buffer[:3] == b'GIF':
            width, height = struct.unpack('<HH', buffer[6:10])
            return {'width': width, 'height': height}
        if len(buffer) > 4 and buffer[:2] == b'\xff\xd8':
            index = 2
            while index+9 < len(buffer):
                if buffer[index] != 255:
                    index += 1
                    continue
                marker = buffer[index+1]
                if marker in {0xd8, 0xd9} or 0xd0 <= marker <= 0xd7:
                    index += 2
                    continue
                size = int.from_bytes(buffer[index+2:index+4], 'big')
                if size < 2:
                    return None
                if 0xc0 <= marker <= 0xcf and marker not in {0xc4, 0xc8, 0xcc}:
                    height, width = struct.unpack('>HH', buffer[index+5:index+9])
                    return {'width': width, 'height': height}
                index += 2+size
        # Native WebP dimensions also enforce the minimum-side rule.
        if len(buffer) >= 30 and buffer[:4] == b'RIFF' and buffer[8:12] == b'WEBP':
            if buffer[12:16] == b'VP8X':
                return {'width': 1+int.from_bytes(buffer[24:27], 'little'), 'height': 1+int.from_bytes(buffer[27:30], 'little')}
            if buffer[12:16] == b'VP8 ' and buffer[23:26] == b'\x9d\x01\x2a':
                return {'width': int.from_bytes(buffer[26:28], 'little') & 0x3fff, 'height': int.from_bytes(buffer[28:30], 'little') & 0x3fff}
            if buffer[12:16] == b'VP8L' and buffer[20] == 0x2f:
                bits = int.from_bytes(buffer[21:25], 'little')
                return {'width': 1+(bits & 0x3fff), 'height': 1+((bits >> 14) & 0x3fff)}
    except (ValueError, IndexError, struct.error):
        pass
    return None


def build_sticker_query(text):
    cleaned = re.sub(r'\[[^\]]*\]', ' ', str(text or ''))
    cleaned = re.sub(r'^(?:(?:请|麻烦|能不能|可以|你|帮我|给我|再)\s*)+', '', cleaned)
    cleaned = re.sub(r'^(?:(?:从)?(?:网上|联网|在线)\s*)?', '', cleaned)
    cleaned = re.sub(r'^(?:搜索|搜|查找|找|发|来)(?:一下)?\s*(?:一张|一个|一些|几张|张)?\s*', '', cleaned)
    cleaned = re.sub(r'(?:的)?\s*(?:表情包|贴纸)', ' 表情包 ', cleaned)
    cleaned = re.sub(r'(?:吧|呀|啊|嘛|呢|看看|就好)[。！!~～]*$', '', cleaned)
    cleaned = re.sub(r'[，。！？、,.!?~～\s]+', ' ', cleaned).strip()
    if re.fullmatch(r'(?:(?:随机|随便|任意|一张|一个)\s*)*表情包', cleaned):
        cleaned = '聊天 表情包'
    return (cleaned or '表情')+('' if re.search(r'表情包|贴纸', cleaned) else ' 表情包')


def parse_bing_image_results(document, limit=10):
    out, seen = [], set()
    for match in re.finditer(r'\bm=(["\x27])(.*?)\1', str(document or ''), re.S):
        try:
            item = json.loads(html.unescape(match[2]))
        except (ValueError, TypeError):
            continue
        if not isinstance(item, dict):
            continue
        url = item.get('murl', '')
        if not isinstance(url, str) or not re.match(r'https?://', url, re.I) or url in seen:
            continue
        seen.add(url)
        out.append({'url': url, 'title': item.get('t') or '', 'pageUrl': item.get('purl') or ''})
        if len(out) >= limit:
            break
    return out


def collect_image_urls(node, out=None, depth=0):
    out = [] if out is None else out
    if depth > 4 or len(out) >= 40:
        return out
    if isinstance(node, str):
        if re.match(r'https?://', node, re.I) and re.search(r'\.(png|jpe?g|gif|webp)(\?|#|$)', node, re.I):
            out.append(node)
    elif isinstance(node, (list, dict)):
        for item in node.values() if isinstance(node, dict) else node:
            collect_image_urls(item, out, depth+1)
    return out


def _count(count):
    try:
        return max(1, min(35, int(count) or 10))
    except (ValueError, TypeError, OverflowError):
        return 10


async def _fetch(url, *, fetch=request, timeout=10, proxy='', configured=False, headers=None, maximum=6*1024*1024):
    response = await fetch(url, maximum=maximum, timeout=timeout, proxy=proxy, configured=configured, headers={'user-agent': UA, **(headers or {})})
    if not response.ok:
        raise ValueError(f'图片资源请求失败 HTTP {response.status}')
    return response


async def search_bing_images(query, *, count=10, fetch=request, proxy='', timeout=8):
    count = _count(count)
    url = 'https://www.bing.com/images/async?'+urlencode({'q': str(query or '表情包'), 'first': 1, 'count': count, 'mkt': 'zh-CN', 'adlt': 'off'})
    response = await _fetch(url, fetch=fetch, proxy=proxy, timeout=timeout, headers={'accept': 'text/html'})
    return parse_bing_image_results(response.text(), count)


async def search_custom_images(query, *, url_template='', key='', count=10, fetch=request, proxy='', timeout=10):
    template = str(url_template or '').strip()
    if not template:
        raise ValueError('自定义搜图接口还没填 URL')
    count = _count(count)
    url = template.replace('{query}', quote(str(query or ''), safe='')).replace('{key}', quote(str(key or ''), safe='')).replace('{count}', str(count))
    response = await _fetch(url, fetch=fetch, proxy=proxy, timeout=timeout, configured=True, headers={'accept': 'application/json'})
    try:
        data = response.json()
    except (ValueError, TypeError):
        raise ValueError('自定义搜图接口没有返回 JSON') from None
    return [{'url': url} for url in list(dict.fromkeys(collect_image_urls(data)))[:count]]


async def search_giphy(query, *, key='', count=10, fetch=request, proxy='', timeout=10):
    if not str(key or '').strip():
        raise ValueError('Giphy 需要先在设置里填 API Key')
    count = _count(count)
    url = 'https://api.giphy.com/v1/stickers/search?'+urlencode({'api_key': key, 'q': str(query or ''), 'limit': count, 'rating': 'pg-13', 'lang': 'zh-CN'})
    response = await _fetch(url, fetch=fetch, proxy=proxy, timeout=timeout, headers={'accept': 'application/json'})
    try:
        items = response.json().get('data', [])
    except (ValueError, TypeError, AttributeError):
        items = []
    out = []
    for item in items if isinstance(items, list) else []:
        images = item.get('images', {}) if isinstance(item, dict) else {}
        url = (images.get('fixed_width') or {}).get('url') or (images.get('original') or {}).get('url')
        if url:
            out.append({'url': url})
    return out[:count]


async def search_tenor(query, *, key='', count=10, fetch=request, proxy='', timeout=10):
    if not str(key or '').strip():
        raise ValueError('Tenor 需要先在设置里填 API Key')
    count = _count(count)
    url = 'https://tenor.googleapis.com/v2/search?'+urlencode({'key': key, 'q': str(query or ''), 'limit': count, 'media_filter': 'gif'})
    response = await _fetch(url, fetch=fetch, proxy=proxy, timeout=timeout, headers={'accept': 'application/json'})
    try:
        items = response.json().get('results', [])
    except (ValueError, TypeError, AttributeError):
        items = []
    out = []
    for item in items if isinstance(items, list) else []:
        formats = item.get('media_formats', {}) if isinstance(item, dict) else {}
        url = (formats.get('gif') or {}).get('url') or (formats.get('tinygif') or {}).get('url')
        if url:
            out.append({'url': url})
    return out[:count]


async def search_domestic_images(query, *, provider='baidu', count=10, fetch=request, proxy='', timeout=8):
    count = _count(count)
    endpoint = 'https://image.so.com/j' if provider == 'so' else 'https://image.baidu.com/search/acjson'
    params = {'q': query, 'pn': count, 'sn': 0} if provider == 'so' else {'tn': 'resultjson_com', 'word': query, 'rn': count, 'pn': 0}
    parts = urlsplit(endpoint)
    response = await _fetch(endpoint+'?'+urlencode(params), fetch=fetch, proxy=proxy, timeout=timeout, headers={'referer': parts.scheme+'://'+parts.netloc})
    data = response.json()
    items = data.get('list' if provider == 'so' else 'data', []) if isinstance(data, dict) else []
    out = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        url = (item.get('img') or item.get('imgurl') or item.get('thumb')) if provider == 'so' else (item.get('middleURL') or item.get('thumbURL'))
        if isinstance(url, str) and re.match(r'https?://', url, re.I):
            out.append({'url': url, 'title': html.unescape(re.sub(r'<[^>]*>', '', str(item.get('fromPageTitle') or item.get('title') or '')))})
    return out[:count]


def relevant_image_result(item, query):
    if not item.get('title'):
        return True
    def normalize(value):
        return ''.join(c for c in re.sub(r'表情包|贴纸|图片|聊天|随机|搞笑', '', str(value).lower()) if c.isalpha() or c.isnumeric())
    wanted, title = normalize(query), normalize(item['title'])
    if not wanted or wanted in title:
        return True
    parts = list(dict.fromkeys(re.findall(r'[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U000323af]+', wanted)))
    grams = [gram for part in parts for gram in ([part] if re.fullmatch(r'[a-z0-9]+', part) else [part[i:i+2] for i in range(len(part)-1)])]
    return bool(grams) and sum(part in title for part in grams)/len(grams) >= .2


async def search_images(query, *, provider='bing', url_template='', key='', count=10, fetch=request, proxy=''):
    if provider in {'baidu', 'so'}:
        return await search_domestic_images(query, provider=provider, count=count, fetch=fetch, proxy=proxy)
    if provider == 'custom':
        return await search_custom_images(query, url_template=url_template, key=key, count=count, fetch=fetch, proxy=proxy)
    if provider == 'giphy':
        return await search_giphy(query, key=key, count=count, fetch=fetch, proxy=proxy)
    if provider == 'tenor':
        return await search_tenor(query, key=key, count=count, fetch=fetch, proxy=proxy)
    return await search_bing_images(query, count=count, fetch=fetch, proxy=proxy)


async def download_image(url, *, max_bytes=MAX_BYTES, min_side=0, fetch=request, proxy='', timeout=10):
    response = await _fetch(url, fetch=fetch, proxy=proxy, timeout=timeout, maximum=max_bytes, headers={'accept': 'image/*'})
    buffer = response.content
    mime = sniff_mime(buffer)
    if not mime:
        raise ValueError('不是支持的图片类型')
    if len(buffer) > max_bytes:
        raise ValueError('图片太大')
    if len(buffer) < 1024:
        raise ValueError('图片太小，可能是占位图')
    size = image_size(buffer)
    if min_side > 0 and size and (size['width'] < min_side or size['height'] < min_side):
        raise ValueError(f"图片尺寸太小（{size['width']}×{size['height']}）")
    return {'buffer': buffer, 'mime': mime, 'size': size, 'dataUrl': 'data:'+mime+';base64,'+base64.b64encode(buffer).decode()}


def safe_diagnostic(error, secrets=()):
    text = re.sub(r'https?://\S+', '[请求地址]', str(error))
    for secret in secrets:
        if secret:
            text = text.replace(str(secret), '[凭据]').replace(quote(str(secret), safe=''), '[凭据]')
    return text[:160]


async def collect_web_images(queries, *, provider='bing', url_template='', key='', limit=6, count=8,
                             min_side=160, min_bytes=8192, max_bytes=MAX_BYTES, proxy='', fetch=request,
                             current=lambda: True, on_diagnostic=lambda event: None):
    count, limit = _count(count), max(0, int(limit))
    if not limit:
        return []
    images, seen, hashes = [], set(), set()
    async def collect(query):
        check_current(current)
        try:
            results = await search_images(query, provider=provider, url_template=url_template, key=key, count=count, fetch=fetch, proxy=proxy)
            check_current(current)
            on_diagnostic({'stage': 'search', 'provider': provider, 'query': query, 'count': len(results)})
            return query, results
        except StaleStickerRequest:
            raise
        except Exception as exc:
            check_current(current)
            on_diagnostic({'stage': 'search-failed', 'provider': provider, 'query': query, 'error': safe_diagnostic(exc, [key, proxy])})
            return query, []
    searches = [asyncio.create_task(collect(query)) for query in list(dict.fromkeys(queries))[:4]]
    try:
        lists = await asyncio.gather(*searches)
    except BaseException:
        # gather propagates one failure without stopping sibling requests. Keep
        # stale/cancelled searches from surviving their owning reply or shutdown.
        for task in searches:
            task.cancel()
        await asyncio.gather(*searches, return_exceptions=True)
        raise
    for index in range(count):
        for query, results in lists:
            check_current(current)
            if len(images) >= limit:
                return images
            item = results[index] if index < len(results) else None
            if not item or not item.get('url') or item['url'] in seen:
                continue
            seen.add(item['url'])
            if not relevant_image_result(item, query):
                on_diagnostic({'stage': 'irrelevant', 'provider': provider})
                continue
            try:
                image = await download_image(item['url'], max_bytes=max_bytes, min_side=min_side, fetch=fetch, proxy=proxy)
                check_current(current)
                if len(image['buffer']) < min_bytes:
                    continue
                hash = hashlib.sha256(image['buffer']).hexdigest()
                if hash in hashes:
                    continue
                hashes.add(hash)
                images.append({**image, 'hash': hash, 'sourceUrl': item['url'], 'query': query, 'title': item.get('title') or ''})
            except StaleStickerRequest:
                raise
            except Exception as exc:
                check_current(current)
                on_diagnostic({'stage': 'download-failed', 'provider': provider, 'error': safe_diagnostic(exc, [key, proxy])})
    return images


async def find_web_image(query, *, count=10, max_bytes=MAX_BYTES, min_side=160, min_bytes=8192, proxy='', fetch=request):
    images = await collect_web_images([query], count=count, max_bytes=max_bytes, min_side=min_side, min_bytes=min_bytes, limit=1, proxy=proxy, fetch=fetch)
    if not images:
        raise ValueError('没有找到可用的图片')
    return images[0]
