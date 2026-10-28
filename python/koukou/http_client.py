"""Bounded HTTP transport with public-resource and explicit configured-endpoint policies."""
import asyncio
from dataclasses import dataclass
import ipaddress
import json
import socket
from urllib.parse import urlsplit, urljoin
import aiohttp
from aiohttp.resolver import DefaultResolver


def public_ip(value):
    ip = ipaddress.ip_address(value.split('%')[0])
    return ip.is_global and not ip.is_multicast


def validate_url(url):
    value = urlsplit(url)
    if value.scheme not in {'http', 'https'} or not value.hostname or value.username or value.password:
        raise ValueError('只接受公开HTTP(S)资源地址')
    if value.hostname.lower() in {'localhost', 'localhost.localdomain'} or value.hostname.lower().endswith('.localhost'):
        raise ValueError('不读取本机或内网资源')
    try:
        address = ipaddress.ip_address(value.hostname.split('%')[0])
    except ValueError:
        address = None
    if address is not None and not public_ip(str(address)):
        raise ValueError('不读取本机或内网资源')
    return value


class PublicResolver(DefaultResolver):
    async def resolve(self, host, port=0, family=0):
        rows = await super().resolve(host, port, family)
        if not rows or any(not public_ip(row['host']) for row in rows):
            raise ValueError('图片地址指向非公开网络')
        return rows


@dataclass
class Response:
    status: int
    content: bytes
    headers: dict

    @property
    def ok(self):
        return 200 <= self.status < 300

    @property
    def mime(self):
        return str(self.headers.get('content-type', '')).partition(';')[0].strip().lower()

    def text(self):
        return self.content.decode('utf-8-sig', errors='replace')

    def json(self):
        return json.loads(self.text())


def origin(url):
    value = urlsplit(url)
    return value.scheme.lower(), value.hostname, value.port or (443 if value.scheme == 'https' else 80)


async def _public_proxy_target(url):
    """A proxy resolves destinations itself, so validate DNS before handing it a URL."""
    value = validate_url(url)
    rows = await asyncio.get_running_loop().getaddrinfo(value.hostname, value.port or (443 if value.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    if not rows or any(not public_ip(row[4][0]) for row in rows):
        raise ValueError('资源地址指向非公开网络')


async def request(url, *, method='GET', maximum=6*1024*1024, timeout=15,
                  headers=None, payload=None, proxy='', configured=False):
    """Read at most maximum decoded bytes, including chunked/compressed responses.

    configured=True is only for an administrator-selected service endpoint. It allows
    a local/private service, but pins redirects to the original origin. Discovered
    image URLs must always use the default public policy. Ambient proxies are ignored.
    Exceptions intentionally omit URLs, response bodies, and credentials.
    """
    if not isinstance(maximum, int) or maximum < 1:
        raise ValueError('下载大小限制无效')
    value = urlsplit(url)
    if value.scheme not in {'http', 'https'} or not value.hostname or value.username or value.password:
        raise ValueError('只接受HTTP(S)资源地址')
    if proxy:
        proxy_value = urlsplit(proxy)
        if proxy_value.scheme not in {'http', 'https'} or not proxy_value.hostname:
            raise ValueError('代理地址无效，仅支持HTTP(S)代理')
    initial_origin = origin(url)
    resolver = DefaultResolver() if configured else PublicResolver()
    connector = aiohttp.TCPConnector(resolver=resolver)
    request_headers = {'User-Agent': 'Mozilla/5.0', **(headers or {})}
    try:
        async with asyncio.timeout(timeout):
            async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=timeout), trust_env=False) as session:
                for _ in range(6):
                    value = urlsplit(url)
                    if value.scheme not in {'http', 'https'} or not value.hostname or value.username or value.password:
                        raise ValueError('只接受HTTP(S)资源地址')
                    if configured:
                        if origin(url) != initial_origin:
                            raise ValueError('配置的接口不允许跨站重定向')
                    else:
                        validate_url(url)
                        if proxy:
                            await _public_proxy_target(url)
                    async with session.request(method, url, headers=request_headers, json=payload,
                                               proxy=proxy or None, allow_redirects=False) as response:
                        if response.status in {301, 302, 303, 307, 308}:
                            location = response.headers.get('Location')
                            if not location:
                                raise ValueError('资源重定向地址为空')
                            next_url = urljoin(url, location)
                            if origin(next_url) != origin(url):
                                request_headers = {k: v for k, v in request_headers.items() if k.lower() not in {'authorization', 'cookie', 'proxy-authorization'}}
                            if response.status == 303 or response.status in {301, 302} and method.upper() == 'POST':
                                method, payload = 'GET', None
                            url = next_url
                            continue
                        if response.content_length is not None and response.content_length > maximum:
                            raise ValueError('资源超过下载大小限制')
                        data = bytearray()
                        async for block in response.content.iter_chunked(65536):
                            if len(data)+len(block) > maximum:
                                raise ValueError('资源超过下载大小限制')
                            data.extend(block)
                        return Response(response.status, bytes(data), {k.lower(): v for k, v in response.headers.items()})
                raise ValueError('资源重定向次数过多')
    except TimeoutError:
        raise ValueError('资源请求超时') from None
    except (aiohttp.ClientError, OSError):
        raise ValueError('资源连接失败') from None
    finally:
        if not connector.closed:
            await connector.close()
        await resolver.close()


async def fetch_public(url, *, maximum=6*1024*1024, timeout=15, headers=None):
    response = await request(url, maximum=maximum, timeout=timeout, headers=headers)
    if not response.ok:
        raise ValueError(f'资源请求失败 HTTP {response.status}')
    return response.content, response.mime
