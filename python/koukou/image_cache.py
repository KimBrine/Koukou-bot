"""Content-addressed image and neutral-description cache, compatible with JS indexes."""
import asyncio
import base64
import hashlib
import re
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from .archive import stamp
from .state import read_json, write_json
from .stickers import image_mime, write_bytes


def reference_keys(image):
    refs = []
    file = str(image.get('file') or '')
    match = re.fullmatch(r'\{?([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\}?(?:\.(?:image|png|jpe?g|gif|webp))?', file, re.I)
    if match:
        refs.append('qq-md5:'+match[1].replace('-', '').lower())
    if image.get('url'):
        try:
            url = urlsplit(image['url'])
            if url.scheme not in {'http', 'https'} or not url.hostname:
                raise ValueError('地址无效')
            if url.hostname in {'gchat.qpic.cn', 'multimedia.nt.qq.com.cn'}:
                params = parse_qs(url.query)
                first = lambda key: params.get(key, [''])[0]
                if first('fileid'):
                    refs.append(f"qq-fileid:{url.hostname}:{url.path}:{first('appid')}:{first('fileid')}:{first('spec')}")
                elif '/gchatpic_new/' in url.path:
                    refs.append(f'qq-path:{url.scheme}://{url.netloc}{url.path}')
            refs.append('url:'+image['url'])
        except (ValueError, TypeError):
            pass
    return list(dict.fromkeys(hashlib.sha256(ref.encode()).hexdigest() for ref in refs))


def part_hash(part, maximum=6*1024*1024):
    url = part.get('image_url', {}).get('url', '')
    if not isinstance(url, str) or len(url) > maximum*4//3+100:
        raise ValueError('图片超过识图大小限制')
    match = re.fullmatch(r'data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)', url)
    if not match:
        raise ValueError('缓存只接受已经下载的图片')
    data = base64.b64decode(match[2], validate=True)
    if not 0 < len(data) <= maximum or image_mime(data) != match[1]:
        raise ValueError('图片内容校验失败')
    return hashlib.sha256(data).hexdigest(), match[1], data


class ImageCache:
    def __init__(self, directory, max_bytes=256*1024*1024, max_entries=2000, max_image_bytes=6*1024*1024, ttl=30*86400000, now=lambda: time.time()*1000):
        directory = Path(directory)
        self.dir, self.now, self.ttl = directory, now, ttl
        self.max_bytes, self.max_entries, self.max_image_bytes = max_bytes, max_entries, max_image_bytes
        self.file = directory / 'index.json'
        value = read_json(self.file, {'version': 1, 'images': [], 'descriptions': []})
        if not isinstance(value, dict) or not isinstance(value.get('images'), list) or not isinstance(value.get('descriptions'), list):
            raise ValueError('图片缓存索引损坏')
        self.images, self.aliases, self.descriptions = {}, {}, {}
        for item in value['images']:
            if not isinstance(item, dict) or not re.fullmatch(r'[a-f0-9]{64}', str(item.get('hash', ''))) or not isinstance(item.get('usedAt'), (int, float)):
                raise ValueError('缓存图片条目无效')
            item['aliases'] = [v for v in item.get('aliases', []) if re.fullmatch(r'[a-f0-9]{64}', str(v))][-64:]
            self.images[item['hash']] = item
            for key in item['aliases']:
                self.aliases[key] = item['hash']
        for key, item in value['descriptions']:
            if not re.fullmatch(r'[a-f0-9]{64}', key) or not isinstance(item, dict) or not isinstance(item.get('hashes'), list) or not isinstance(item.get('text'), str):
                raise ValueError('缓存描述条目无效')
            self.descriptions[key] = item
        self.loading, self.describing = {}, {}
        self.jobs = set()
        self.image_hits, self.description_hits = 0, 0

    def track(self, task, mapping, keys):
        self.jobs.add(task)
        def done(task):
            self.jobs.discard(task)
            for key in keys:
                if mapping.get(key) is task:
                    mapping.pop(key, None)
            if not task.cancelled():
                task.exception()
        task.add_done_callback(done)

    async def close(self):
        for task in list(self.jobs):
            task.cancel()
        await asyncio.gather(*list(self.jobs), return_exceptions=True)

    def path(self, hash):
        if not re.fullmatch(r'[a-f0-9]{64}', hash):
            raise ValueError('缓存哈希无效')
        path = self.dir / (hash+'.bin')
        if path.is_symlink() or self.dir.is_symlink():
            raise ValueError('缓存不支持符号链接')
        return path

    def save(self):
        write_json(self.file, {'version': 1, 'images': list(self.images.values()), 'descriptions': list(map(list, self.descriptions.items()))})

    def remove(self, hash):
        item = self.images.pop(hash, {})
        for alias in item.get('aliases', []):
            if self.aliases.get(alias) == hash:
                self.aliases.pop(alias, None)
        self.descriptions = {k: v for k, v in self.descriptions.items() if hash not in v['hashes']}
        self.path(hash).unlink(missing_ok=True)

    def prune(self):
        for hash, item in list(self.images.items()):
            if self.now()-item['usedAt'] > self.ttl:
                self.remove(hash)
        for hash, item in sorted(list(self.images.items()), key=lambda pair: pair[1]['usedAt']):
            if sum(v['size'] for v in self.images.values()) <= self.max_bytes and len(self.images) <= self.max_entries:
                break
            self.remove(hash)
        self.descriptions = {k: v for k, v in self.descriptions.items() if self.now()-v.get('usedAt', 0) <= self.ttl and all(h in self.images for h in v['hashes'])}
        ordered = sorted(self.descriptions, key=lambda k: self.descriptions[k]['usedAt'], reverse=True)
        self.descriptions = {k: self.descriptions[k] for k in ordered[:self.max_entries]}

    def touch(self, item, refs):
        item['usedAt'] = self.now()
        for ref in refs:
            if ref not in item['aliases']:
                item['aliases'].append(ref)
            self.aliases[ref] = item['hash']
        while len(item['aliases']) > 64:
            old = item['aliases'].pop(0)
            if self.aliases.get(old) == item['hash']:
                self.aliases.pop(old, None)

    async def load(self, image, download):
        self.prune()
        refs = reference_keys(image)
        for ref in refs:
            item = self.images.get(self.aliases.get(ref))
            if not item:
                continue
            try:
                path = self.path(item['hash'])
                if path.stat().st_size > self.max_image_bytes:
                    raise ValueError('缓存图片超过大小限制')
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != item['hash'] or image_mime(data) != item['mime']:
                    raise ValueError('缓存图片校验失败')
                self.touch(item, refs); self.save(); self.image_hits += 1
                return {'hash': item['hash'], 'part': {'type':'image_url','image_url':{'url':'data:'+item['mime']+';base64,'+base64.b64encode(data).decode()}}}
            except (OSError, ValueError):
                self.remove(item['hash'])
        prior = next((self.loading[ref] for ref in refs if ref in self.loading), None)
        if prior:
            result = await asyncio.shield(prior)
            if result and result['hash'] in self.images:
                self.touch(self.images[result['hash']], refs); self.save()
            return result
        async def run():
            part = await download()
            if not part:
                return None
            hash, mime, data = part_hash(part, self.max_image_bytes)
            if len(data) <= self.max_bytes:
                write_bytes(self.path(hash), data)
                item = self.images.setdefault(hash, {'hash':hash,'mime':mime,'size':len(data),'usedAt':self.now(),'aliases':[]})
                self.touch(item, refs); self.prune(); self.save()
            return {'hash': hash, 'part': part}
        task = asyncio.create_task(run())
        for ref in refs:
            self.loading[ref] = task
        self.track(task, self.loading, refs)
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                for ref in refs:
                    if self.loading.get(ref) is task:
                        self.loading.pop(ref, None)

    async def describe(self, hashes, scope, generate):
        key = stamp([scope, hashes])
        previous = self.descriptions.get(key)
        if previous and self.now()-previous['usedAt'] <= self.ttl and all(h in self.images for h in hashes):
            previous['usedAt'] = self.now(); self.save(); self.description_hits += 1
            return previous['text']
        if key in self.describing:
            return await asyncio.shield(self.describing[key])
        async def run():
            text = str(await generate() or '').strip()
            if not text:
                raise ValueError('识图接口没有返回描述')
            if hashes and all(h in self.images for h in hashes):
                self.descriptions[key] = {'hashes':hashes,'text':text,'usedAt':self.now()}
                self.prune(); self.save()
            return text
        task = asyncio.create_task(run()); self.describing[key] = task
        self.track(task, self.describing, [key])
        try:
            return await asyncio.shield(task)
        finally:
            if task.done() and self.describing.get(key) is task:
                self.describing.pop(key, None)

    def stats(self):
        return {'imageHits':self.image_hits,'descriptionHits':self.description_hits,'images':len(self.images),'descriptions':len(self.descriptions),'bytes':sum(v['size'] for v in self.images.values())}
