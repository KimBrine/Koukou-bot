"""Persona-isolated sticker stores. Context weights never depend on age or usage."""
import base64
import copy
import hashlib
import math
import os
from pathlib import Path
import random as random_module
import re
import time
import unicodedata
import uuid
from .archive import stamp, json_text
from .state import read_json, write_json

MAX_BYTES, LIMIT = 4*1024*1024, 60
MIMES = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'}
SCENES = [{'id': id, 'name': name} for id, name in [('happy','开心'),('like','喜欢/赞同'),('shy','害羞/卖萌'),('laugh','笑/无语'),('sad','难过/求安慰'),('angry','生气/吐槽'),('tired','累/困'),('question','疑惑'),('bye','告别'),('other','其他')]]


def safe_ancestors(path):
    for parent in [Path(path), *Path(path).parents]:
        if parent.exists() and (parent.is_symlink() or getattr(parent.lstat(), 'st_file_attributes', 0) & 0x400):
            raise ValueError('图片目录不支持符号链接或重解析路径')


def image_mime(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8'):
        return 'image/jpeg'
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


def parse_data_url(value):
    if not isinstance(value, str) or len(value) > (MAX_BYTES*4//3+4096):
        raise ValueError('图片数据过大或格式错误')
    match = re.fullmatch(r'data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)', value.strip())
    if not match:
        raise ValueError('只支持PNG/JPEG/WebP/GIF图片')
    try:
        data = base64.b64decode(re.sub(r'\s', '', match[2]), validate=True)
    except ValueError as error:
        raise ValueError('图片Base64数据无效') from error
    if not 0 < len(data) <= MAX_BYTES or image_mime(data) != match[1]:
        raise ValueError('图片内容、格式或大小无效，单张最多4MB')
    return match[1], data


def write_bytes(file, data):
    file = Path(file)
    safe_ancestors(file.parent)
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.is_symlink() or file.parent.is_symlink():
        raise ValueError('图片路径不支持符号链接')
    temp = file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        with temp.open('xb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, file)
    finally:
        temp.unlink(missing_ok=True)


def metadata(input):
    values = input.get('keywords') or []
    if not isinstance(values, list):
        values = re.split(r'[,，\s]+', str(values))
    scenes = input.get('scenes', [])
    return {'name': str(input.get('name') or '').strip()[:40], 'keywords': [str(s).strip() for s in values if str(s).strip()][:12],
            'description': str(input.get('description') or '').strip()[:1000], 'scenes': [s for s in scenes if s in {c['id'] for c in SCENES}] if isinstance(scenes, list) else []}


def clean_query(value):
    value = re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(value or '')).lower()).strip()
    # JS matching uses UTF-16 code units. Keep its thresholds for emoji keywords too.
    units = value.encode('utf-16-le')
    return ''.join(chr(int.from_bytes(units[i:i+2], 'little')) for i in range(0, len(units), 2))


def candidate_weights(items, queries):
    queries = queries if isinstance(queries, list) else [queries]
    qs = set(filter(None, map(clean_query, queries)))
    names = {s['id']: s['name'] for s in SCENES}
    def dice(a, b):
        if min(len(a), len(b)) < 2:
            return 0
        x, y = {a[i:i+2] for i in range(len(a)-1)}, {b[i:i+2] for i in range(len(b)-1)}
        return 2*len(x & y)/(len(x)+len(y))
    out = []
    for item in items:
        name, id = clean_query(item['name']), clean_query(item['id'])
        words = list(filter(None, [name, *map(clean_query, item.get('keywords', [])), *[clean_query(names.get(s, s)) for s in item.get('scenes', [])]]))
        weight = 0
        for q in qs:
            score = 1.7 if q in {id, name} else 1.5 if q in words else 0
            if any(q in w or len(w) >= 2 and w in q for w in words):
                score = max(score, 1.2)
            if any(len(w) == 1 and w in q for w in words):
                score = max(score, 1.0)
            if len(q) >= 2 and any(dice(q, w) >= .5 for w in words):
                score = max(score, 1.0)
            weight = max(weight, score)
        if weight:
            out.append({'item': item, 'weight': weight})
    return out


class StickerStore:
    def __init__(self, directory, now=lambda: time.time()*1000):
        self.dir, self.now = Path(directory), now
        safe_ancestors(self.dir)
        if self.dir.is_symlink():
            raise ValueError('图库不支持符号链接')
        self.index = self.dir / 'stickers.json'
        self.blocked_file = self.dir / 'blacklist.json'
        self.learning_file = self.dir / 'learning-state.json'
        for file in [self.index, self.blocked_file, self.learning_file]:
            if file.is_symlink():
                raise ValueError('图库状态不支持符号链接')
        self.blocked = read_json(self.blocked_file, [])
        raw = read_json(self.index, [])
        if not isinstance(self.blocked, list) or any(not isinstance(v, dict) or not re.fullmatch(r'[a-f0-9]{64}', v.get('hash', '')) for v in self.blocked):
            raise ValueError('表情包黑名单格式损坏，暂停使用')
        if not isinstance(raw, list):
            raise ValueError('表情包索引格式损坏，保留原文件')
        self.items = []
        for item in raw:
            if not isinstance(item, dict) or not re.fullmatch(r'[a-f0-9]{64}', str(item.get('hash', ''))) or not item.get('id'):
                raise ValueError('表情包条目格式损坏')
            self.path(item)
            usage = item.get('usage', 0)
            self.items.append({**item, **metadata(item), 'origin': 'learned' if item.get('origin') == 'learned' else 'manual',
                               'usage': max(0, usage) if isinstance(usage, (int, float)) and math.isfinite(usage) else 0,
                               'lastContexts': item.get('lastContexts', [])[:8] if isinstance(item.get('lastContexts', []), list) else []})
        self.items = [item for item in self.items if not self.is_blocked(item['hash'])]
        state = read_json(self.learning_file, {'pausedByCapacity': False})
        if not isinstance(state, dict) or not isinstance(state.get('pausedByCapacity', False), bool):
            raise ValueError('学习容量状态损坏，未自动开启学习')
        self.paused = state.get('pausedByCapacity', False)
        self.learning_status()

    def path(self, item):
        name = item.get('file', '')
        if not re.fullmatch(r'[a-fA-F0-9]{16,64}\.(?:png|jpg|jpeg|webp|gif)', name):
            raise ValueError('图库文件路径无效')
        path = self.dir / name
        if path.is_symlink():
            raise ValueError('图库文件不支持符号链接')
        return path

    def list(self):
        return copy.deepcopy(sorted(self.items, key=lambda item: item.get('addedAt', 0), reverse=True))

    def get(self, id):
        return next((item for item in self.items if item['id'] == id), None)

    def save(self):
        write_json(self.index, self.items)

    def is_blocked(self, hash):
        return any(item['hash'] == hash for item in self.blocked)

    def learning_status(self):
        if len(self.items) >= LIMIT and not self.paused:
            write_json(self.learning_file, {'pausedByCapacity': True}); self.paused = True
        return {'limit': LIMIT, 'full': len(self.items) >= LIMIT, 'pausedByCapacity': self.paused}

    def learning_allowed(self):
        state = self.learning_status()
        return not state['full'] and not state['pausedByCapacity']

    def resume_learning(self):
        if len(self.items) >= LIMIT:
            raise ValueError('当前人格图库已满60张，请先人工清理')
        write_json(self.learning_file, {'pausedByCapacity': False}); self.paused = False

    def add(self, input):
        mime, data = parse_data_url(input.get('dataUrl'))
        hash = hashlib.sha256(data).hexdigest()
        if self.is_blocked(hash):
            raise ValueError('这张图片已在表情包黑名单中')
        existing = next((v for v in self.items if v['hash'] == hash), None)
        if existing:
            if input.get('name') and input.get('origin') != 'learned':
                self.update(existing['id'], {'name': input['name']})
            return {'item': self.get(existing['id']), 'duplicated': True}
        if len(self.items) >= LIMIT:
            self.learning_status(); raise ValueError('当前人格图库已满60张，请先人工清理')
        name = hash[:16]+'.'+MIMES[mime]
        file = self.dir / name
        if file.exists() and hashlib.sha256(file.read_bytes()).hexdigest() != hash:
            raise ValueError('图库文件名冲突，未覆盖原文件')
        write_bytes(file, data)
        item = {**metadata(input), 'name': metadata(input)['name'] or f'表情{len(self.items)+1}', 'id': str(uuid.uuid4())[:8], 'file': name,
                'hash': hash, 'mime': mime, 'size': len(data), 'origin': 'learned' if input.get('origin') == 'learned' else 'manual',
                'source': str(input.get('source') or '')[:120], 'usage': 0, 'lastContexts': [], 'addedAt': self.now()}
        self.items.append(item)
        try:
            self.save()
        except BaseException:
            self.items.pop(); file.unlink(missing_ok=True); raise
        self.learning_status()
        return {'item': item, 'duplicated': False}

    def update(self, id, patch):
        item = self.get(id)
        if item is None:
            return None
        next_item = {**item, **metadata({**item, **{k: v for k, v in patch.items() if k in {'name','keywords','description','scenes'}}})}
        next_item['name'] = next_item['name'] or item['name']
        file = None
        if patch.get('dataUrl'):
            mime, data = parse_data_url(patch['dataUrl']); hash = hashlib.sha256(data).hexdigest()
            if self.is_blocked(hash) or any(v['id'] != id and v['hash'] == hash for v in self.items):
                raise ValueError('图片已被拉黑或存在于另一条表情包')
            file = self.dir / (hash[:16]+'.'+MIMES[mime])
            if file.exists() and file.name != item['file'] and hashlib.sha256(file.read_bytes()).hexdigest() != hash:
                raise ValueError('图库文件名冲突')
            write_bytes(file, data)
            next_item.update(file=file.name, mime=mime, hash=hash, size=len(data))
        index = self.items.index(item); self.items[index] = next_item
        try:
            self.save()
        except BaseException:
            self.items[index] = item
            if file and file.name != item['file']:
                file.unlink(missing_ok=True)
            raise
        if file and file.name != item['file']:
            self.path(item).unlink(missing_ok=True)
        return next_item

    def remove(self, id):
        item = self.get(id)
        if item is None:
            return False
        index = self.items.index(item); self.items.pop(index)
        try:
            self.save()
        except BaseException:
            self.items.insert(index, item); raise
        self.path(item).unlink(missing_ok=True)
        return True

    def blacklist(self, id):
        item = self.get(id)
        if item is None:
            return False
        data = self.image(item)
        if data is None:
            raise ValueError('图片哈希无法核对，未拉黑')
        write_bytes(self.dir / 'blacklist-images' / item['hash'], data)
        blocked = [v for v in self.blocked if v['hash'] != item['hash']]+[{k: item[k] for k in ['hash','name','keywords','description','mime','size']} | {'blockedAt': self.now()}]
        write_json(self.blocked_file, blocked); self.blocked = blocked
        self.remove(id)
        return True

    def unblock(self, hash):
        if not self.is_blocked(hash):
            return False
        next_items = [v for v in self.blocked if v['hash'] != hash]
        write_json(self.blocked_file, next_items); self.blocked = next_items
        (self.dir / 'blacklist-images' / hash).unlink(missing_ok=True)
        return True

    def blacklist_image(self, hash):
        if not re.fullmatch(r'[a-f0-9]{64}', str(hash)) or not self.is_blocked(hash):
            return None
        path = self.dir / 'blacklist-images' / hash
        if path.is_symlink() or path.parent.is_symlink():
            return None
        if not path.exists():
            cached = self.dir.parent / 'image-cache' / (hash+'.bin')
            if not cached.is_symlink() and cached.is_file() and cached.stat().st_size <= MAX_BYTES:
                data = cached.read_bytes()
                if hashlib.sha256(data).hexdigest() == hash and image_mime(data):
                    write_bytes(path, data)
        if path.is_file() and path.stat().st_size <= MAX_BYTES:
            data = path.read_bytes()
            return data if hashlib.sha256(data).hexdigest() == hash else None
        return None

    def blacklist_entries(self):
        return sorted([{**v, 'hasPreview': self.blacklist_image(v['hash']) is not None} for v in self.blocked], key=lambda v: v.get('blockedAt', 0), reverse=True)

    def image(self, item):
        if not item or self.is_blocked(item['hash']) or not any(v['id'] == item['id'] and v['hash'] == item['hash'] and v['file'] == item['file'] for v in self.items):
            return None
        file = self.path(item)
        if not file.is_file() or file.stat().st_size > MAX_BYTES:
            return None
        data = file.read_bytes()
        return data if hashlib.sha256(data).hexdigest() == item['hash'] else None

    def data_url(self, item):
        data = self.image(item)
        return 'data:'+item['mime']+';base64,'+base64.b64encode(data).decode() if data else None

    def candidates(self, queries):
        return candidate_weights(self.items, queries)

    def choose(self, queries, limit=1, rand=random_module.random):
        pool, out = self.candidates(queries), []
        while pool and len(out) < limit:
            roll, index = rand()*sum(v['weight'] for v in pool), len(pool)-1
            for i, candidate in enumerate(pool):
                roll -= candidate['weight']
                if roll < 0:
                    index = i; break
            out.append(pool.pop(index)['item'])
        return out

    def random(self, rand=random_module.random):
        return self.items[min(len(self.items)-1, max(0, int(rand()*len(self.items))))] if self.items else None

    def pick(self, context, rand=random_module.random):
        choices = self.choose([context], rand=rand)
        return choices[0] if choices else self.random(rand)

    def find(self, query, exact=False, rand=random_module.random):
        if exact:
            return next((v for v in self.items if v['name'].lower() == str(query).strip().lower() or v['id'] == query), None)
        choices = self.choose([query], rand=rand)
        return choices[0] if choices else None

    def note_usage(self, id, text):
        item = self.get(id)
        if item is None:
            return False
        context = re.sub(r'\s+', ' ', str(text or '')).strip()[:60]
        previous = copy.deepcopy(item)
        item['usage'] += 1
        if context:
            item['lastContexts'] = [context, *[c for c in item['lastContexts'] if c != context]][:8]
        try:
            self.save()
        except BaseException:
            item.clear(); item.update(previous); raise
        return True


class PersonaStickers:
    def __init__(self, config, memory, settings):
        self.config, self.memory, self.settings = config, memory, settings
        self.dir = config.data_dir / 'stickers'
        self.registry_file = self.dir / 'persona-libraries.json'
        owner = config.get('ACTIVE_PERSONA')
        self.registry = read_json(self.registry_file, {'version': 1, 'legacyOwner': owner, 'legacyKey': self.key_of(owner)})
        if self.registry.get('version') != 1 or not isinstance(self.registry.get('legacyOwner'), str) or self.registry.get('legacyKey') != self.key_of(self.registry['legacyOwner']):
            raise ValueError('人格表情包归属记录损坏')
        self.libraries = {}

    @staticmethod
    def key_of(name):
        return stamp(['persona', name])

    def scope(self, key=None):
        name = self.settings.get(key, {}).get('persona') or self.config.get('ACTIVE_PERSONA')
        hash = self.key_of(name)
        token = json_text([hash, getattr(self.config, 'persona_revision', 0), self.memory.version(key) if key else ''])
        return {'key': hash, 'name': name or '默认人格', 'token': token}

    def for_chat(self, key=None):
        selected = self.scope(key)
        if not self.registry_file.exists():
            write_json(self.registry_file, self.registry)
        if selected['key'] not in self.libraries:
            directory = self.dir if selected['key'] == self.registry['legacyKey'] else self.dir / 'personas' / selected['key']
            self.libraries[selected['key']] = StickerStore(directory)
        return self.libraries[selected['key']]

    def snapshot(self, key=None):
        scope = self.scope(key)
        return {**scope, 'store': self.for_chat(key), 'current': lambda: self.scope(key)['token'] == scope['token']}


def extract_markers(text):
    requested, queries = '[索要表情包]' in text, []
    text = text.replace('[索要表情包]', '')
    def remove(match):
        value = match[1].strip()
        if value:
            queries.append(value)
        return ''
    text = re.sub(r'\[贴纸[:：]\s*([^\]\n]{1,40})\]', remove, text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return {'text': re.sub(r'[ \t]+$', '', text, flags=re.M).strip(), 'queries': queries, 'requested': requested}
