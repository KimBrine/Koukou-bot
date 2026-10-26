"""Read-only structural audit of an explicitly selected JS/Python instance data tree.

This module never constructs a runtime, migrates a file, creates a directory,
connects to a provider, or prints private paths, identities, text or credentials.
The manifest is a digest, not a copy or an atomic snapshot of a running instance.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat

from .config import parse_env
from .custom import clean as clean_command
from .greetings import validate as validate_greetings
from .memory import validate_recent, validate_long, valid_key
from .providers import base_url
from .sessions import persona_name, persona_text
from .stickers import image_mime, MAX_BYTES, LIMIT
from .image_cache import validate_index


HASH = re.compile(r"[a-f0-9]{64}")
EPOCH = re.compile(r"[A-Za-z0-9_-]{1,80}")
IMAGE_NAME = re.compile(r"[a-fA-F0-9]{16,64}\.(?:png|jpe?g|webp|gif)")
MAX_JSON = 32 * 1024 * 1024
MAX_FILES = 20000


def _finite(value, *, nonnegative=True):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and (not nonnegative or value >= 0))


def _object(value):
    if not isinstance(value, dict):
        raise ValueError('object')


def _list(value):
    if not isinstance(value, list):
        raise ValueError('list')


def _boundary(value):
    _object(value)
    if not _finite(value.get('resetAt', 0)) or not isinstance(value.get('keyResetAt', {}), dict):
        raise ValueError('boundary')
    for key, at in value.get('keyResetAt', {}).items():
        valid_key(key)
        if not _finite(at):
            raise ValueError('boundary')


def _recent(value):
    validate_recent(value)
    for entries in value.values():
        if any(item.get('time') is not None and not _finite(item['time']) for item in entries):
            raise ValueError('time')


def _long(value):
    validate_long(value)
    for item in value.values():
        if 'paused' in item and not isinstance(item['paused'], bool):
            raise ValueError('paused')
        if not _finite(item.get('updatedAt', 0)):
            raise ValueError('time')
        for pending in item.get('pending', []):
            if not _finite(pending.get('time', 0)):
                raise ValueError('time')
        retry = item.get('retry')
        if retry is not None:
            _object(retry)
            for field in ('attempts', 'nextAttemptAt', 'maxChars'):
                if field in retry and not _finite(retry[field]):
                    raise ValueError('retry')


def _epochs(value):
    _object(value)
    if not isinstance(value.get('keyEpochs', {}), dict):
        raise ValueError('epoch')
    if not isinstance(value.get('epoch', 'legacy'), str) or not EPOCH.fullmatch(value.get('epoch', 'legacy')):
        raise ValueError('epoch')
    for key, epoch in value.get('keyEpochs', {}).items():
        valid_key(key)
        if not isinstance(epoch, str) or not EPOCH.fullmatch(epoch):
            raise ValueError('epoch')
    for key in value.get('clearedKeys', []):
        valid_key(key)
    if value.get('resetPending'):
        raise ValueError('reset_pending')


def _settings(value):
    _object(value)
    for key, item in value.items():
        valid_key(key)
        _object(item)
        for field in ('enabled', 'atReplyEnabled', 'proactiveEnabled'):
            if field in item and not isinstance(item[field], bool):
                raise ValueError('setting')
        for field, low, high in [('proactiveRate', 0, 1), ('emojiKeepRate', 0, 1), ('replyMaxLines', 1, 5), ('lineMaxChars', 10, 200)]:
            if item.get(field) is not None and (not _finite(item[field]) or not low <= item[field] <= high):
                raise ValueError('setting')
        if item.get('persona'):
            persona_name(item['persona'])
        for field in ('customPrompt', 'note', 'personaDigest'):
            if field in item and not isinstance(item[field], str):
                raise ValueError('setting')
        quiet = item.get('quietHours')
        if quiet not in (None, ''):
            match = re.fullmatch(r'(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})', str(quiet))
            if not match or any(int(match[n]) > high for n, high in [(1, 23), (2, 59), (3, 23), (4, 59)]):
                raise ValueError('quiet')


def _command_center(value):
    _object(value)
    if value.get('version') != 1 or not isinstance(value.get('builtins'), dict):
        raise ValueError('commands')
    for item in value['builtins'].values():
        _object(item)
        if 'scope' in item and item['scope'] not in {'all', 'private', 'group', 'groups'}:
            raise ValueError('scope')
        if 'groups' in item and (not isinstance(item['groups'], list)
                or any(not _finite(v) or int(v) != v or v <= 0 for v in item['groups'])):
            raise ValueError('groups')


def _providers(value):
    _list(value)
    ids = set()
    for item in value:
        _object(item)
        identifier = item.get('id', '')
        if not isinstance(identifier, str) or not re.fullmatch(r'vp_[A-Za-z0-9_-]{1,60}', identifier) or identifier in ids:
            raise ValueError('provider')
        ids.add(identifier)
        base_url(item.get('baseUrl'))
        if any(field in item and not isinstance(item[field], str) for field in ('name', 'model', 'apiKey')):
            raise ValueError('provider')


class _Audit:
    def __init__(self, root):
        self.errors, self.warnings = [], []
        self.files, self.manifest = {}, []
        self.anchors = [(Path(root).absolute(), 'data')]
        self.counts = {'files': 0, 'bytes': 0, 'recentChats': 0, 'longChats': 0, 'memoryPartitions': 0,
                       'personas': 0, 'stickerLibraries': 0, 'stickers': 0, 'blacklisted': 0,
                       'archiveRecords': 0, 'dailyRecords': 0, 'cachedImages': 0}

    def issue(self, area, code, *, warning=False):
        target = self.warnings if warning else self.errors
        item = {'area': area, 'code': code}
        if item not in target:
            target.append(item)

    def safe(self, path, area):
        # Do not resolve first: resolving would erase evidence of a symlink/junction.
        path = Path(path).absolute()
        for parent in [path, *path.parents]:
            try:
                info = parent.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                self.issue(area, 'linked_path')
                return False
        return True

    def entries(self, path, area):
        if not self.safe(path, area) or not path.exists():
            return []
        if not path.is_dir():
            self.issue(area, 'expected_directory')
            return []
        return sorted(path.iterdir(), key=lambda p: p.name)

    def read(self, path, area, *, limit=MAX_JSON):
        if not self.safe(path, area):
            return None
        try:
            before = path.stat()
            if not stat.S_ISREG(before.st_mode):
                self.issue(area, 'expected_regular_file')
                return None
            if before.st_size > limit:
                self.issue(area, 'audit_size_limit')
                return None
            if len(self.files) >= MAX_FILES and path not in self.files:
                self.issue(area, 'audit_file_limit')
                return None
            # A live writer may grow the file after stat; keep the read bounded
            # too, rather than allocating whatever size it grew to.
            with path.open('rb') as stream:
                data = stream.read(limit+1)
            if len(data) > limit:
                self.issue(area, 'audit_size_limit')
                self.issue(area, 'changed_during_audit')
                return None
            after = path.stat()
            signature = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
            if signature(before) != signature(after):
                self.issue(area, 'changed_during_audit')
            label = None
            for anchor, prefix in self.anchors:
                try:
                    label = prefix+'/'+path.relative_to(anchor).as_posix()
                    break
                except ValueError:
                    continue
            key = hashlib.sha256(os.fsencode(label or path.name)).hexdigest()
            digest = hashlib.sha256(data).hexdigest()
            if path not in self.files:
                self.counts['files'] += 1
                self.counts['bytes'] += len(data)
            self.files[path] = signature(after)
            self.manifest.append((key, digest))
            return data
        except OSError:
            self.issue(area, 'unreadable_file')
            return None

    def json(self, path, area, validator=None):
        if not path.exists() and not path.is_symlink():
            return None
        data = self.read(path, area)
        if data is None:
            return None
        def pairs(values):
            result = {}
            for key, value in values:
                if key in result:
                    raise ValueError('duplicate_key')
                result[key] = value
            return result
        try:
            value = json.loads(data.decode('utf-8-sig'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')), object_pairs_hook=pairs)
            if validator:
                validator(value)
            return value
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
            self.issue(area, 'invalid_structure')
            return None

    def memory(self, root):
        recent = self.json(root/'memory.json', 'recent_memory', _recent)
        long = self.json(root/'long-memory.json', 'long_memory', _long)
        self.counts['recentChats'] = len(recent or {})
        self.counts['longChats'] = len(long or {})
        self.json(root/'memory.json.reset.json', 'memory_boundary', _boundary)
        self.json(root/'long-memory.json.state.json', 'memory_boundary', _epochs)
        for file in self.entries(root, 'data'):
            if file.name.startswith(('memory__', 'long-memory__')) and file.suffix == '.json':
                is_recent = file.name.startswith('memory__')
                def partition(value):
                    _object(value)
                    (_recent if is_recent else _long)(value.get('chats'))
                    (_boundary if is_recent else _epochs)(value)
                if self.json(file, 'memory_partition', partition) is not None:
                    self.counts['memoryPartitions'] += 1
        for name in ('session-transition.json', 'restore-pending.json', 'restore-transition.json'):
            if (root/name).exists() or (root/name).is_symlink():
                self.json(root/name, 'pending_transaction', _object)
                self.issue('pending_transaction', 'recovery_required')

    def personas(self, directory, settings, env):
        names = set()
        for file in self.entries(directory, 'personas'):
            if file.suffix != '.txt':
                continue
            data = self.read(file, 'personas', limit=262144)
            if data is None:
                continue
            try:
                persona_name(file.stem)
                persona_text(data.decode('utf-8-sig'))
            except (ValueError, UnicodeError):
                self.issue('personas', 'invalid_persona')
                continue
            if file.stem.casefold() in {name.casefold() for name in names}:
                self.issue('personas', 'case_insensitive_name_collision')
            names.add(file.stem)
            self.counts['personas'] += 1
        selected = set()
        if env.get('ACTIVE_PERSONA') and not env.get('PERSONA', '').strip():
            selected.add(env['ACTIVE_PERSONA'])
        selected.update(item.get('persona') for item in (settings or {}).values() if item.get('persona'))
        if selected - names:
            self.issue('personas', 'selected_persona_missing')

    def library(self, directory):
        items = self.json(directory/'stickers.json', 'stickers', _list)
        blocked = self.json(directory/'blacklist.json', 'sticker_blacklist', _list)
        learning = self.json(directory/'learning-state.json', 'sticker_learning', _object)
        if learning is not None and not isinstance(learning.get('pausedByCapacity', False), bool):
            self.issue('sticker_learning', 'invalid_structure')
        if items is None and blocked is None and learning is None:
            return
        self.counts['stickerLibraries'] += 1
        self.counts['stickers'] += len(items or [])
        self.counts['blacklisted'] += len(blocked or [])
        if len(items or []) > LIMIT:
            self.issue('stickers', 'capacity_exceeded')
        if len(items or []) >= LIMIT and not (learning or {}).get('pausedByCapacity'):
            self.issue('sticker_learning', 'capacity_lock_needed', warning=True)
        ids, hashes = set(), set()
        for item in items or []:
            try:
                _object(item)
                if not isinstance(item.get('id'), str) or not item['id'] or item['id'] in ids:
                    raise ValueError('id')
                if not isinstance(item.get('hash'), str) or not HASH.fullmatch(item['hash']) or item['hash'] in hashes:
                    raise ValueError('hash')
                if not isinstance(item.get('file'), str) or not IMAGE_NAME.fullmatch(item['file']):
                    raise ValueError('path')
                if any(field in item and not isinstance(item[field], str) for field in ('name', 'description')):
                    raise ValueError('metadata')
                if any(field in item and (not isinstance(item[field], list) or any(not isinstance(v, str) for v in item[field])) for field in ('keywords', 'scenes', 'lastContexts')):
                    raise ValueError('metadata')
                ids.add(item['id']); hashes.add(item['hash'])
                data = self.read(directory/item['file'], 'sticker_image', limit=MAX_BYTES)
                if data is not None and (not data or hashlib.sha256(data).hexdigest() != item['hash'] or image_mime(data) != item.get('mime')):
                    self.issue('sticker_image', 'content_hash_or_mime_mismatch')
                if data is not None and item.get('size') is not None and item['size'] != len(data):
                    self.issue('sticker_image', 'size_mismatch')
            except (ValueError, TypeError, KeyError):
                self.issue('stickers', 'invalid_structure')
        for item in blocked or []:
            if not isinstance(item, dict) or not isinstance(item.get('hash'), str) or not HASH.fullmatch(item['hash']):
                self.issue('sticker_blacklist', 'invalid_structure')
                continue
            if item['hash'] in hashes:
                self.issue('sticker_blacklist', 'blocked_entry_in_active_index', warning=True)
            file = directory/'blacklist-images'/item['hash']
            if file.exists() or file.is_symlink():
                data = self.read(file, 'blacklist_preview', limit=MAX_BYTES)
                if data is not None and hashlib.sha256(data).hexdigest() != item['hash']:
                    self.issue('blacklist_preview', 'content_hash_mismatch')

    def stickers(self, root):
        directory = root/'stickers'
        registry = self.json(directory/'persona-libraries.json', 'sticker_personas', _object)
        if registry is not None:
            owner = registry.get('legacyOwner')
            expected = None
            if isinstance(owner, str):
                try:
                    expected = hashlib.sha256(json.dumps(['persona', owner], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
                except UnicodeError:
                    pass
            if registry.get('version') != 1 or expected is None or registry.get('legacyKey') != expected:
                self.issue('sticker_personas', 'invalid_owner_registry')
        elif (directory/'stickers.json').exists():
            self.issue('sticker_personas', 'legacy_owner_binding_required', warning=True)
        self.library(directory)
        for child in self.entries(directory/'personas', 'sticker_personas'):
            if not HASH.fullmatch(child.name):
                self.issue('sticker_personas', 'invalid_library_directory')
                continue
            if not self.safe(child, 'sticker_personas') or not child.is_dir():
                self.issue('sticker_personas', 'invalid_library_directory')
                continue
            self.library(child)

    def jsonl(self, file, area):
        # A bounded audit deliberately reports oversize files rather than silently
        # inspecting a tail and claiming the whole archive was validated.
        data = self.read(file, area)
        if data is None:
            return
        count = 0
        try:
            for line in data.decode('utf-8-sig').splitlines():
                if not line.strip():
                    continue
                item = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
                _object(item)
                if not isinstance(item.get('text'), str) or not _finite(item.get('time', 0)):
                    raise ValueError('record')
                count += 1
            self.counts['dailyRecords' if area == 'daily_archive' else 'archiveRecords'] += count
        except (ValueError, UnicodeError, TypeError, RecursionError):
            self.issue(area, 'invalid_jsonl_record')

    def archives(self, root):
        for group in self.entries(root/'daily', 'daily_archive'):
            if not re.fullmatch(r'\d{1,24}', group.name) or not self.safe(group, 'daily_archive') or not group.is_dir():
                self.issue('daily_archive', 'invalid_partition')
                continue
            for file in self.entries(group, 'daily_archive'):
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.jsonl', file.name):
                    continue
                self.jsonl(file, 'daily_archive')
        for epoch in self.entries(root/'long-memory.json.records', 'long_archive'):
            if not EPOCH.fullmatch(epoch.name) or not self.safe(epoch, 'long_archive') or not epoch.is_dir():
                self.issue('long_archive', 'invalid_partition')
                continue
            for file in self.entries(epoch, 'long_archive'):
                if not re.fullmatch(r'[a-f0-9]{64}\.jsonl', file.name):
                    self.issue('long_archive', 'invalid_record_filename')
                    continue
                self.jsonl(file, 'long_archive')

    def cache(self, root):
        directory = root/'image-cache'
        value = self.json(directory/'index.json', 'image_cache', validate_index)
        if value is None:
            return
        images, _ = validate_index(value)
        self.counts['cachedImages'] = len(images)
        for hash, item in images.items():
            file = directory/(hash+'.bin')
            if not file.exists() and not file.is_symlink():
                self.issue('image_cache', 'missing_rebuildable_image', warning=True)
                continue
            data = self.read(file, 'image_cache', limit=6*1024*1024)
            if data is not None and (hashlib.sha256(data).hexdigest() != hash or image_mime(data) != item['mime'] or len(data) != item['size']):
                self.issue('image_cache', 'content_hash_or_mime_mismatch')

    def finish(self):
        for path, signature in self.files.items():
            try:
                info = path.stat()
                if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != signature:
                    self.issue('data', 'changed_during_audit')
            except OSError:
                self.issue('data', 'changed_during_audit')
        fingerprint = hashlib.sha256(json.dumps(sorted(self.manifest), separators=(',', ':')).encode()).hexdigest()
        return {'version': 1, 'scope': 'read-only-structure', 'compatible': not self.errors, 'ready': False,
                'errors': self.errors, 'warnings': self.warnings, 'counts': self.counts, 'fingerprint': fingerprint,
                'limitations': ['not_atomic_live_snapshot', 'backups_and_transient_logs_not_audited',
                                'plugins_and_external_paths_require_separate_audit',
                                'not_runtime_or_provider_acceptance', 'no_files_modified']}


def audit_data(data_dir, *, persona_dir=None, env_file=None):
    """Audit explicit paths only. A compatible report is not cutover approval.

    JSON/JSONL files above 32MiB and trees above 20,000 inspected files are
    reported incomplete. Never truncate input silently or quarantine source data.
    """
    root = Path(data_dir).absolute()
    audit = _Audit(root)
    try:
        if not audit.safe(root, 'data') or not root.exists() or not root.is_dir():
            audit.issue('data', 'missing_or_invalid_data_directory')
            return audit.finish()
        env = {}
        if env_file is not None:
            environment = Path(env_file).absolute()
            audit.anchors.append((environment.parent, 'environment'))
            data = audit.read(environment, 'configuration', limit=1024*1024)
            if data is not None:
                try:
                    env = parse_env(data.decode('utf-8-sig'))
                    if '\0' in data.decode('utf-8-sig'):
                        raise ValueError('nul')
                except (UnicodeError, ValueError):
                    audit.issue('configuration', 'invalid_utf8_environment')
        if env.get('PERSONA_DIR') and persona_dir is None:
            audit.issue('personas', 'explicit_persona_directory_not_audited', warning=True)
        if env.get('PERSONA_FILE'):
            audit.issue('personas', 'explicit_persona_file_not_audited', warning=True)
        audit.memory(root)
        settings = audit.json(root/'chat-settings.json', 'chat_settings', _settings)
        selected_personas = Path(persona_dir).absolute() if persona_dir is not None else root/'personas'
        if persona_dir is not None:
            audit.anchors.insert(0, (selected_personas, 'personas'))
        audit.personas(selected_personas, settings, env)
        if (root/'persona.txt').exists() or (root/'persona.txt').is_symlink():
            data = audit.read(root/'persona.txt', 'persona_fallback', limit=262144)
            if data is not None:
                try:
                    persona_text(data.decode('utf-8-sig'))
                except (UnicodeError, ValueError):
                    audit.issue('persona_fallback', 'invalid_persona')
        def custom(value):
            _list(value)
            if len(value) > 200:
                raise ValueError('commands')
            for command in value:
                clean_command(command)
        audit.json(root/'custom-commands.json', 'custom_commands', custom)
        audit.json(root/'command-center.json', 'command_center', _command_center)
        audit.json(root/'vision-providers.json', 'vision_providers', _providers)
        def greetings(value):
            _object(value)
            if value.get('version') != 1 or not isinstance(value.get('libraries'), dict):
                raise ValueError('greetings')
            for key, library in value['libraries'].items():
                if not HASH.fullmatch(key):
                    raise ValueError('greetings')
                validate_greetings(library)
        audit.json(root/'persona-greetings.json', 'greetings', greetings)
        audit.stickers(root)
        audit.archives(root)
        audit.cache(root)
        from .backup import RECEIPTS
        for name in sorted(RECEIPTS):
            audit.json(root/name, 'delivery_journal', _object)
        if not audit.counts['files']:
            audit.issue('data', 'no_recognized_data', warning=True)
    except OSError:
        # OS messages often contain a private absolute path: never return them.
        audit.issue('data', 'unreadable_directory')
    return audit.finish()
