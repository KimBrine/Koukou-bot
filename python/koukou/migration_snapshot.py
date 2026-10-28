"""Explicit isolated snapshots and restore rehearsals; never overwrite a source.

All data files are copied unless the caller names exclusions. A complete snapshot
proves two stable file/hash scans, not that a live application was quiescent.
Only new destinations are supported; this module has no in-place restore/delete.
"""
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time

from .state import write_json


FORMAT = 'koukou.native-migration-snapshot'
MANIFEST = 'snapshot.json'
CHUNK = 1024*1024
HASH = re.compile(r'[a-f0-9]{64}')


class SnapshotError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _io_error_code(error):
    # Inspect OS codes, never localized messages or private filenames. Preserve
    # the path/link checks rather than silently changing to Windows device paths.
    if isinstance(error, OSError) and (error.errno == errno.ENAMETOOLONG
                                      or getattr(error, 'winerror', None) == 206):
        return 'snapshot_path_too_long'
    return 'snapshot_io_or_structure_error'


def _safe(path):
    path = Path(path).absolute()
    for parent in (path, *path.parents):
        try:
            info = parent.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise SnapshotError('linked_or_reparse_path')
    return path


def _identity(path):
    return hashlib.sha256(os.fsencode(os.path.normcase(str(Path(path).resolve())))).hexdigest()


def _relative(value):
    if not isinstance(value, str) or not value or '\\' in value or re.search(r'[<>:"|?*\x00-\x1f]', value):
        raise SnapshotError('invalid_manifest_path')
    parts = value.split('/')
    if any(part in {'', '.', '..'} or part.endswith((' ', '.')) or re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.I) for part in parts):
        raise SnapshotError('invalid_manifest_path')
    if PurePosixPath(value).is_absolute():
        raise SnapshotError('invalid_manifest_path')
    return value


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _read_file(path, *, expected=None, target=None):
    """Bound a live-file read to its initial size and compare the opened identity."""
    path = _safe(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise SnapshotError('unsupported_file_type')
    if expected is not None and _signature(before) != expected:
        raise SnapshotError('source_changed')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    handle = os.open(path, flags)
    output = None
    try:
        if _signature(os.fstat(handle)) != _signature(before):
            raise SnapshotError('source_changed')
        if target is not None:
            target = _safe(target)
            output = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        digest, size, remaining = hashlib.sha256(), 0, before.st_size
        while remaining:
            block = os.read(handle, min(CHUNK, remaining))
            if not block:
                raise SnapshotError('source_changed')
            digest.update(block); size += len(block); remaining -= len(block)
            if output is not None:
                view = memoryview(block)
                while view:
                    count = os.write(output, view)
                    if count <= 0:
                        raise OSError('short snapshot write')
                    view = view[count:]
        if os.read(handle, 1) or _signature(os.fstat(handle)) != _signature(before):
            raise SnapshotError('source_changed')
        _safe(path)
        if _signature(path.lstat()) != _signature(before):
            raise SnapshotError('source_changed')
        if output is not None:
            os.fsync(output)
        return {'size': size, 'sha256': digest.hexdigest()}, _signature(before)
    finally:
        os.close(handle)
        if output is not None:
            os.close(output)


def _excluded(relative, exclude):
    return any(relative == entry or relative.startswith(entry+'/') for entry in exclude)


def _inventory(root, exclude=()):
    root = _safe(root)
    if not root.is_dir():
        raise SnapshotError('source_directory_missing')
    files, directories, signatures = {}, [], {}
    # Inspect links even in excluded trees, but do not hash their excluded files.
    stack = [root]
    while stack:
        directory = _safe(stack.pop())
        for path in sorted(directory.iterdir(), key=lambda item: item.name):
            _safe(path)
            relative = _relative(path.relative_to(root).as_posix())
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                stack.append(path)
                if not _excluded(relative, exclude):
                    directories.append(relative)
            elif stat.S_ISREG(info.st_mode):
                if not _excluded(relative, exclude):
                    files[relative], signatures[relative] = _read_file(path)
            else:
                raise SnapshotError('unsupported_file_type')
    return {'files': files, 'directories': sorted(directories), 'signatures': signatures}


def _payload(inventory, env=None):
    files = {'data/'+name: item for name, item in inventory['files'].items()}
    directories = ['data', *('data/'+name for name in inventory['directories'])]
    if env is not None:
        files['config/source.env.backup'] = env
        directories.append('config')
    return {'files': files, 'directories': sorted(directories)}


def _fingerprint(payload, scope):
    value = {'files': payload['files'], 'directories': payload['directories'], 'scope': scope}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def _report(status, *, code=None, manifest=None):
    value = {'ok': status in {'complete', 'verified'}, 'status': status, 'ready': False,
             'errors': [code] if code else [], 'fingerprint': None,
             'counts': {'files': 0, 'bytes': 0, 'directories': 0},
             'consistency': 'stable_double_scan_only', 'stoppedInstanceVerified': False}
    if manifest:
        files = manifest.get('files', {})
        value.update(fingerprint=manifest.get('fingerprint'), counts={'files': len(files),
            'bytes': sum(item['size'] for item in files.values()), 'directories': len(manifest.get('directories', []))},
            scope={'exclusionCount': len(manifest.get('scope', {}).get('excluded', [])),
                   'explicitEnvCopy': bool(manifest.get('scope', {}).get('explicitEnvCopy')),
                   'exactScopeInPrivateManifest': True})
    return value


def _new_destination(destination, source=None, protected=()):
    destination = _safe(destination)
    if destination.exists():
        raise SnapshotError('destination_must_be_new')
    if not destination.parent.is_dir():
        raise SnapshotError('destination_parent_missing')
    if source is not None:
        source = _safe(source).resolve()
        target = destination.resolve()
        if target == source or target.is_relative_to(source) or source.is_relative_to(target):
            raise SnapshotError('destination_overlaps_source')
    if any(_identity(parent) in protected for parent in (destination, *destination.parents)):
        raise SnapshotError('destination_is_protected_source')
    destination.mkdir(mode=0o700)
    return destination


def _write_manifest(destination, manifest):
    _safe(destination)
    _safe(destination/MANIFEST)
    write_json(destination/MANIFEST, manifest)


def _mkdirs(destination, directories):
    for name in sorted(directories, key=lambda value: (value.count('/'), value)):
        path = _safe(destination/_relative(name))
        path.mkdir(mode=0o700)


def _fail(destination, manifest, code):
    if destination is None:
        return _report('refused', code=code)
    manifest.update(status='incomplete', error=code)
    try:
        _write_manifest(destination, manifest)
    except (OSError, SnapshotError):
        # The initial durable state was already incomplete. Never erase partial
        # data or pretend a disk-full/permission failure produced a usable copy.
        pass
    return _report('incomplete', code=code)


def create_snapshot(source_dir, destination, *, exclude=(), env_file=None):
    """Copy all explicit source data to a fresh directory; never modify a source.

    Exclusions are exact relative files/subtrees, never wildcard patterns, and
    are recorded inside the private manifest. There are no implicit exclusions.
    """
    target, manifest = None, {}
    try:
        source = _safe(source_dir)
        if not source.is_dir():
            raise SnapshotError('source_directory_missing')
        exclusions = sorted(set(_relative(value) for value in exclude))
        target = _new_destination(destination, source)
        scope = {'data': 'all-files-except-explicit-exclusions', 'excluded': exclusions,
                 'explicitEnvCopy': env_file is not None}
        manifest = {'format': FORMAT, 'version': 1, 'kind': 'snapshot', 'status': 'incomplete',
                    'createdAt': time.time()*1000, 'scope': scope, 'files': {}, 'directories': [],
                    'protectedIdentities': [_identity(source)], 'consistency': 'stable_double_scan_only',
                    'stoppedInstanceVerified': False}
        _write_manifest(target, manifest)
        before = _inventory(source, exclusions)
        env_data, env_signature = _read_file(Path(env_file)) if env_file is not None else (None, None)
        payload = _payload(before, env_data)
        _mkdirs(target, payload['directories'])
        for name, expected in before['files'].items():
            copied, _ = _read_file(source/name, expected=before['signatures'][name], target=target/'data'/name)
            if copied != expected:
                raise SnapshotError('source_changed')
        if env_file is not None:
            copied, _ = _read_file(Path(env_file), expected=env_signature, target=target/'config'/'source.env.backup')
            if copied != env_data:
                raise SnapshotError('source_changed')
        after = _inventory(source, exclusions)
        if before != after:
            raise SnapshotError('source_changed')
        if env_file is not None and _read_file(Path(env_file), expected=env_signature)[0] != env_data:
            raise SnapshotError('source_changed')
        written = _inventory(target, (MANIFEST,))
        if written['files'] != payload['files'] or written['directories'] != payload['directories']:
            raise SnapshotError('copied_payload_mismatch')
        manifest.update(**payload, fingerprint=_fingerprint(payload, scope), status='complete')
        _write_manifest(target, manifest)
        return _report('complete', manifest=manifest)
    except SnapshotError as exc:
        return _fail(target, manifest, exc.code)
    except (OSError, ValueError, UnicodeError, TypeError) as exc:
        return _fail(target, manifest, _io_error_code(exc))


def _load_manifest(root):
    file = _safe(root/MANIFEST)
    before = file.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > 32*1024*1024:
        raise SnapshotError('invalid_snapshot_manifest')
    handle = os.open(file, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        if _signature(os.fstat(handle)) != _signature(before):
            raise SnapshotError('snapshot_changed')
        chunks, remaining = [], before.st_size
        while remaining:
            block = os.read(handle, min(CHUNK, remaining))
            if not block:
                raise SnapshotError('snapshot_changed')
            chunks.append(block); remaining -= len(block)
        if os.read(handle, 1) or _signature(os.fstat(handle)) != _signature(before):
            raise SnapshotError('snapshot_changed')
        _safe(file)
        if _signature(file.lstat()) != _signature(before):
            raise SnapshotError('snapshot_changed')
        data = b''.join(chunks)
    finally:
        os.close(handle)
    if len(data) > 32*1024*1024:
        raise SnapshotError('invalid_snapshot_manifest')
    def pairs(values):
        out = {}
        for key, value in values:
            if key in out:
                raise SnapshotError('invalid_snapshot_manifest')
            out[key] = value
        return out
    try:
        manifest = json.loads(data.decode('utf-8-sig'), object_pairs_hook=pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(SnapshotError('invalid_snapshot_manifest')))
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise SnapshotError('invalid_snapshot_manifest') from exc
    if (not isinstance(manifest, dict) or manifest.get('format') != FORMAT or manifest.get('version') != 1
            or manifest.get('status') != 'complete' or manifest.get('kind') not in {'snapshot', 'rehearsal'}
            or not isinstance(manifest.get('files'), dict) or not isinstance(manifest.get('directories'), list)
            or not isinstance(manifest.get('scope'), dict) or not isinstance(manifest.get('protectedIdentities'), list)
            or not manifest.get('protectedIdentities')):
        raise SnapshotError('snapshot_incomplete_or_invalid')
    scope = manifest['scope']
    if (scope.get('data') != 'all-files-except-explicit-exclusions' or not isinstance(scope.get('excluded'), list)
            or not isinstance(scope.get('explicitEnvCopy'), bool)
            or any(not isinstance(identity, str) or not HASH.fullmatch(identity) for identity in manifest['protectedIdentities'])):
        raise SnapshotError('invalid_snapshot_manifest')
    for item in scope['excluded']:
        _relative(item)
    for name, item in manifest['files'].items():
        _relative(name)
        if (not (name.startswith('data/') or name == 'config/source.env.backup') or not isinstance(item, dict)
                or not isinstance(item.get('size'), int) or isinstance(item['size'], bool) or item['size'] < 0
                or not isinstance(item.get('sha256'), str) or not HASH.fullmatch(item['sha256'])):
            raise SnapshotError('invalid_snapshot_manifest')
    for name in manifest['directories']:
        _relative(name)
        if not (name == 'data' or name.startswith('data/') or name == 'config'):
            raise SnapshotError('invalid_snapshot_manifest')
    if (len(set(manifest['directories'])) != len(manifest['directories']) or 'data' not in manifest['directories']
            or ('config/source.env.backup' in manifest['files']) != scope['explicitEnvCopy']
            or ('config' in manifest['directories']) != scope['explicitEnvCopy']
            or set(manifest['directories']) & manifest['files'].keys()):
        raise SnapshotError('invalid_snapshot_manifest')
    for name in [*manifest['files'], *manifest['directories']]:
        if '/' in name and name.rsplit('/', 1)[0] not in manifest['directories']:
            raise SnapshotError('invalid_snapshot_manifest')
    if manifest.get('fingerprint') != _fingerprint(manifest, scope):
        raise SnapshotError('snapshot_fingerprint_mismatch')
    return manifest


def _verified(root):
    root = _safe(root)
    if not root.is_dir():
        raise SnapshotError('snapshot_directory_missing')
    manifest = _load_manifest(root)
    actual = _inventory(root, (MANIFEST,))
    if actual['files'] != manifest['files'] or actual['directories'] != sorted(manifest['directories']):
        raise SnapshotError('snapshot_payload_mismatch')
    # A manifest rewritten while hashing cannot silently change the verified scope.
    if _load_manifest(root) != manifest:
        raise SnapshotError('snapshot_changed')
    return manifest, actual


def verify_snapshot(snapshot_dir):
    """Validate every payload file/hash and the exact file/directory collection."""
    try:
        manifest, _ = _verified(Path(snapshot_dir).absolute())
        return _report('verified', manifest=manifest)
    except SnapshotError as exc:
        return _report('refused', code=exc.code)
    except (OSError, ValueError, UnicodeError, TypeError) as exc:
        return _report('refused', code=_io_error_code(exc))


def derive_rehearsal(snapshot_dir, destination):
    """Produce a verified new rehearsal copy, never restore over any instance.

    No config file is activated and no runtime/QQ process is started. The source
    data path identity remains protected even if that original directory is gone.
    """
    target, manifest = None, {}
    try:
        source = _safe(snapshot_dir)
        original, verified = _verified(source)
        target = _new_destination(destination, source, original['protectedIdentities'])
        manifest = {**original, 'kind': 'rehearsal', 'status': 'incomplete', 'createdAt': time.time()*1000,
                    'protectedIdentities': sorted(set([*original['protectedIdentities'], _identity(source)]))}
        _write_manifest(target, manifest)
        _mkdirs(target, original['directories'])
        for name, expected in original['files'].items():
            copied, _ = _read_file(source/name, expected=verified['signatures'][name], target=target/name)
            if copied != expected:
                raise SnapshotError('snapshot_changed')
        if _verified(source)[0] != original:
            raise SnapshotError('snapshot_changed')
        actual = _inventory(target, (MANIFEST,))
        if actual['files'] != original['files'] or actual['directories'] != sorted(original['directories']):
            raise SnapshotError('copied_payload_mismatch')
        manifest['status'] = 'complete'
        _write_manifest(target, manifest)
        return _report('complete', manifest=manifest)
    except SnapshotError as exc:
        return _fail(target, manifest, exc.code)
    except (OSError, ValueError, UnicodeError, TypeError) as exc:
        return _fail(target, manifest, _io_error_code(exc))
