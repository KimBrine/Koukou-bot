"""Optional native 64-bit dHash; no shell helpers and no substitute file hashes.

Pillow bicubic interpolation is deliberately a separately versioned algorithm from
the former System.Drawing implementation. Legacy cache rows are recomputed, never
mixed with native fingerprints. Without Pillow, supported is explicitly False.
"""
import asyncio
import base64
import hashlib
import io
from pathlib import Path
import re
import warnings
from .state import read_json, write_json
from .stickers import MAX_BYTES, image_mime


try:
    from PIL import Image, __version__ as PILLOW_VERSION
except ImportError:
    Image, PILLOW_VERSION = None, ''


def distance(a, b):
    if not isinstance(a, str) or not isinstance(b, str) or not re.fullmatch(r'[01]{64}', a) or not re.fullmatch(r'[01]{64}', b):
        return 64
    return sum(left != right for left, right in zip(a, b))


class ImageHasher:
    def __init__(self, config, *, roots=None, logger=None, pillow=None, max_pixels=40_000_000):
        directory = Path(config.data_dir if hasattr(config, 'data_dir') else config)
        self.file, self.logger, self.max_pixels = directory/'sticker-hashes.json', logger, max_pixels
        self.image = Image if pillow is None else pillow if pillow is not False else None
        self.supported = self.image is not None
        self.algorithm = 'pillow-dhash64-bicubic-rgb-v1:'+PILLOW_VERSION if self.supported else ''
        self.roots = [Path(root).absolute() for root in (roots if roots is not None else [directory/'stickers'])]
        self.cache = read_json(self.file, {})
        if not isinstance(self.cache, dict) or any(not isinstance(key, str) or not isinstance(row, dict) or not re.fullmatch(r'[01]{64}', str(row.get('hash', ''))) for key, row in self.cache.items()):
            raise ValueError('相似图指纹缓存无效，未覆盖原文件')
        self.lock, self.revisions = asyncio.Lock(), {}

    def _path(self, file):
        path = Path(file).absolute()
        if not any(path.is_relative_to(root) for root in self.roots):
            raise ValueError('相似图检测只读取本实例表情包目录')
        for component in [path, *path.parents]:
            if component.exists() or component.is_symlink():
                info = component.lstat()
                if component.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
                    raise ValueError('相似图检测不支持链接或重解析路径')
        if not any(path.resolve().is_relative_to(root.resolve()) for root in self.roots):
            raise ValueError('相似图检测路径越界')
        return path

    @staticmethod
    def _metadata(path):
        info = path.stat()
        return {'mtime': info.st_mtime_ns/1_000_000, 'mtimeNs': info.st_mtime_ns,
                'ctimeNs': info.st_ctime_ns, 'size': info.st_size, 'inode': info.st_ino}

    def _fresh(self, row, info):
        return row and row.get('algorithm') == self.algorithm and all(row.get(key) == value for key, value in info.items())

    def hash_data(self, data):
        if not self.supported:
            return None
        if not isinstance(data, bytes) or not 0 < len(data) <= MAX_BYTES or not image_mime(data):
            raise ValueError('相似图只接受大小合规的PNG/JPEG/WebP/GIF图片')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', self.image.DecompressionBombWarning)
                with self.image.open(io.BytesIO(data)) as original:
                    if original.format not in {'PNG', 'JPEG', 'WEBP', 'GIF'} or not 0 < original.width*original.height <= self.max_pixels:
                        raise ValueError('图片解码尺寸超过相似图检测限制')
                    original.seek(0)  # Animated images use their first complete frame.
                    rgba = original.convert('RGBA')
                    background = self.image.new('RGBA', rgba.size, (0, 0, 0, 255))
                    rgb = self.image.alpha_composite(background, rgba).convert('RGB')
                    reduced = rgb.resize((9, 8), resample=self.image.Resampling.BICUBIC)
                    pixels = list(reduced.get_flattened_data()) if hasattr(reduced, 'get_flattened_data') else list(reduced.getdata())
            values = [.299*red+.587*green+.114*blue for red, green, blue in pixels]
            return ''.join('1' if values[y*9+x] < values[y*9+x+1] else '0' for y in range(8) for x in range(8))
        except (OSError, SyntaxError, Warning) as exc:
            raise ValueError('图片解码失败，未生成相似图指纹') from exc

    def _file_hash(self, path):
        before = self._metadata(path)
        if before['size'] > MAX_BYTES:
            raise ValueError('图片文件超过相似图检测大小限制')
        with path.open('rb') as stream:
            data = stream.read(MAX_BYTES+1)
        value = self.hash_data(data)
        after = self._metadata(path)
        if before != after:
            raise ValueError('图片在检测期间被替换，已取消旧指纹')
        return {**after, 'hash': value, 'sha256': hashlib.sha256(data).hexdigest(), 'algorithm': self.algorithm}

    def _save(self):
        try:
            write_json(self.file, self.cache)
        except OSError:
            if self.logger:
                self.logger.warning('相似图指纹缓存保存失败，仍保留内存结果')

    async def hash_files(self, files):
        if not self.supported:
            return False
        async with self.lock:
            changed = False
            for file in list(dict.fromkeys(str(file) for file in files))[:1000]:
                path = self._path(file)
                key = str(path)
                try:
                    if self._fresh(self.cache.get(key), self._metadata(path)):
                        continue
                    revision = self.revisions.get(key, 0)
                    value = await asyncio.to_thread(self._file_hash, path)
                    # A concurrent blacklist/delete can invalidate an in-flight row.
                    if revision == self.revisions.get(key, 0) and self._metadata(path) == {k:v for k,v in value.items() if k in {'mtime','mtimeNs','ctimeNs','size','inode'}}:
                        self.cache[key] = value
                        changed = True
                except (ValueError, OSError):
                    if key in self.cache:
                        del self.cache[key]
                        changed = True
                    if self.logger:
                        self.logger.warning('图片已变化或无法解码，跳过本次相似图检测')
            if changed:
                self._save()
        return True

    def hash_of(self, item, directory=None):
        file = item.get('file') if isinstance(item, dict) else None
        if not self.supported or not file:
            return None
        path = Path(file)
        if not path.is_absolute():
            if directory is None:
                return None
            path = Path(directory)/path
        try:
            path = self._path(path)
            row = self.cache.get(str(path))
            return row['hash'] if self._fresh(row, self._metadata(path)) else None
        except (ValueError, OSError):
            return None

    def forget(self, file):
        path = self._path(file)
        key = str(path)
        self.revisions[key] = self.revisions.get(key, 0)+1
        self.cache.pop(key, None)
        self._save()

    distance = staticmethod(distance)

    async def detect_similar(self, store, *, current=lambda: True, threshold=8):
        if not self.supported:
            return {'supported': False, 'checked': 0, 'groups': [], 'message': '未安装Pillow，暂不支持相似图检测；文件哈希去重仍可用'}
        items = list(store.list())
        await self.hash_files([Path(store.dir)/item['file'] for item in items])
        if not current():
            raise ValueError('人格或表情包范围已变化，已取消相似图结果')
        groups = []
        for index, a in enumerate(items):
            left = self.hash_of(a, store.dir)
            if left is None:
                continue
            for b in items[index+1:]:
                right = self.hash_of(b, store.dir)
                if right is None:
                    continue
                delta = distance(left, right)
                if delta <= threshold:
                    groups.append({'distance': delta, 'a': {'id': a['id'], 'name': a['name']}, 'b': {'id': b['id'], 'name': b['name']}})
        return {'checked': len(items), 'groups': sorted(groups, key=lambda row: row['distance'])[:200]}

    async def similar(self, data_url, selected, *, threshold=8):
        if not self.supported:
            return False
        match = re.fullmatch(r'data:image/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)', str(data_url))
        if not match or len(match[1]) > MAX_BYTES*4//3+8:
            return False
        candidate = await asyncio.to_thread(self.hash_data, base64.b64decode(match[1], validate=True))
        store = selected['store']
        await self.hash_files([Path(store.dir)/item['file'] for item in store.list()])
        if not selected['current']():
            return False
        return any(value is not None and distance(candidate, value) <= threshold
                   for item in store.list() if (value := self.hash_of(item, store.dir)) is not None)
