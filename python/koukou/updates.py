"""Read-only public GitHub tag checks, with bounded single-flight caching."""
import asyncio
import copy
import inspect
import json
from pathlib import Path
import re
from .http_client import request
from .observability import timestamp
from .resources import source_version_file


UPDATE_REPOSITORY = 'KimBrine/Koukou-bot'
_VERSION = re.compile(r'v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', re.ASCII)


def version(value):
    match = _VERSION.fullmatch(str(value or ''))
    return tuple(int(part) for part in match.groups()) if match else None


def compare_versions(a, b):
    left, right = version(a), version(b)
    if left is None or right is None:
        return None
    return (left > right)-(left < right)


def local_version(root):
    """Read the actual shipped package version; never invent a migration release."""
    file = source_version_file(root)
    if not file.is_file() or file.stat().st_size > 65536:
        raise ValueError('当前程序缺少有效的公开版本记录')
    record = json.loads(file.read_text(encoding='utf-8-sig'))
    value = record.get('version') if isinstance(record, dict) else None
    if version(value) is None:
        raise ValueError('当前公开版本记录没有正式语义版本号')
    return str(value).removeprefix('v')


class UpdateChecker:
    def __init__(self, current_version=None, *, root=None, fetch=request, now=timestamp):
        if current_version is None:
            if root is None:
                raise ValueError('更新检查需要当前安装目录或实际版本号')
            current_version = local_version(root)
        self.current_version, self.fetch, self.now = str(current_version), fetch, now
        self.cached, self.inflight, self.next_check = None, None, 0

    def snapshot(self):
        return {**copy.deepcopy(self.cached or {}), 'currentVersion': self.current_version, 'repository': UPDATE_REPOSITORY}

    async def check(self, *, force=False):
        if self.inflight is not None:
            return await asyncio.shield(self.inflight)
        if self.cached and self.now() < self.next_check and (not force or self.now()-self.cached.get('checkedAt', 0) < 30000):
            return self.snapshot()
        self.inflight = asyncio.create_task(self._check())
        task = self.inflight
        def complete(done):
            if self.inflight is done:
                self.inflight = None
            # Calling coroutine cancellation does not discard the shared request.
            if not done.cancelled():
                done.exception()
        task.add_done_callback(complete)
        return await asyncio.shield(task)

    async def _check(self):
        try:
            async with asyncio.timeout(8):
                response = await self.fetch(f'https://api.github.com/repos/{UPDATE_REPOSITORY}/tags?per_page=100',
                    headers={'accept': 'application/vnd.github+json', 'user-agent': 'Koukou-Studio-update-check'},
                    timeout=8, maximum=512*1024)
                if not response.ok:
                    raise ValueError('仓库不可公开访问或不存在' if response.status == 404 else 'GitHub检查暂被限流，请稍后重试' if response.status in {403, 429} else 'GitHub HTTP '+str(response.status))
                tags = response.json()
                tags = await tags if inspect.isawaitable(tags) else tags
                if not isinstance(tags, list):
                    raise ValueError('GitHub返回格式异常')
                stable = sorted((item['name'] for item in tags[:100] if isinstance(item, dict) and version(item.get('name')) is not None), key=version, reverse=True)
                if not stable:
                    raise ValueError('未找到正式版本标签')
                tag = stable[0]
                comparison = compare_versions(tag, self.current_version)
                if comparison is None:
                    raise ValueError('当前版本不是正式语义版本，无法比较')
                self.cached = {'status': 'available' if comparison > 0 else 'ahead' if comparison < 0 else 'current',
                               'latestVersion': tag.removeprefix('v'), 'checkedAt': self.now(),
                               'url': f'https://github.com/{UPDATE_REPOSITORY}/tree/{tag}', 'message': ''}
                self.next_check = self.now()+6*60*60*1000
        except (ValueError, OSError, RuntimeError, TimeoutError) as exc:
            # The transport omits request/credential details. For injected clients
            # retain only the fixed user-facing errors produced in this module.
            text = str(exc)
            safe = text if re.match(r'^(?:仓库不可公开访问|GitHub|未找到正式版本标签|当前版本不是正式语义版本)', text) else '更新检查暂时失败，请稍后重试'
            self.cached = {'status': 'error', 'checkedAt': self.now(), 'message': safe[:180]}
            self.next_check = self.now()+15*60*1000
        return self.snapshot()

    async def close(self):
        if self.inflight is not None:
            task = self.inflight
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if self.inflight is task:
                self.inflight = None
