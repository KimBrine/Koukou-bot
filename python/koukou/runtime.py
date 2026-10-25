"""Instance-owned native services and bounded, independent maintenance jobs.

Constructing a runtime does not connect to QQ or call a model. The public CLI
keeps its migration gate; explicit start flags exist for isolated acceptance
fixtures and the future, separately approved production cutover.
"""
import asyncio
import base64
import inspect
import logging
import re
from functools import partial
from urllib.parse import urlsplit

from .config import Config
from .state import InstanceLock, read_json
from .sessions import recover_session
from .backup import Backup
from .memory import Memory, LongMemory
from .plugins import PluginManager
from .models import ModelClient, ModelError
from .onebot import OneBot
from .admin import Admin
from .bot import Bot
from .image_cache import ImageCache
from .sticker_learn import StickerLearner
from .stickers import image_mime
from .http_client import fetch_public
from .rate_limit import RateLimiter
from .web_search import WebSearch
from .web_sticker import find_web_sticker
from .vision import GroundedVisionClient
from .file_commands import FileCommands
from .observability import Notifier, health_alert_for_error
from .scheduled import ScheduledCommands
from .daily_ping import DailyPing
from .id_check import IdCheck


def bounded(config, key, default, low, high):
    return min(high, max(low, config.number(key, default)))


class ModelPool:
    """Hot configuration, immutable per-request clients, separate role queues."""
    def __init__(self, config, session, factory=ModelClient):
        self.config, self.session, self.factory = config, session, factory
        self.clients = {}

    def vision_endpoint(self, provider):
        c, raw = self.config, str(provider or 'dashscope')
        provider = raw.lower()
        if provider == 'deepseek':
            return (c.get('DEEPSEEK_API_KEY'), c.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'), c.get('VISION_MODEL', 'deepseek-flash'), None)
        if provider == 'dashscope':
            reasoning = c.get('VISION_REASONING', 'none').lower()
            thinking = reasoning != 'none' if reasoning else c.enabled('DASHSCOPE_ENABLE_THINKING', False)
            return (c.get('DASHSCOPE_API_KEY'), c.get('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), c.get('DASHSCOPE_MODEL', 'qwen-vl-plus'), thinking)
        if provider == 'custom' or provider.startswith('custom:'):
            items = read_json(c.data_dir / 'vision-providers.json', [])
            if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                raise ValueError('自定义识图配置格式错误')
            item = next((item for item in items if provider == 'custom' or 'custom:'+str(item.get('id')) == raw), None)
            if item:
                return (str(item.get('apiKey') or ''), str(item.get('baseUrl') or ''), str(item.get('model') or ''), None)
            if provider == 'custom':
                return (c.get('VISION_CUSTOM_API_KEY'), c.get('VISION_CUSTOM_BASE_URL'), c.get('VISION_CUSTOM_MODEL'), None)
        return ('', '', '', None)

    def specification(self, role):
        c = self.config
        timeout = bounded(c, 'TIMEOUT_MS', 90000, 5000, 3600000)/1000
        concurrency = int(bounded(c, 'MAX_CONCURRENCY', 2, 1, 8))
        retries = int(bounded(c, 'MAX_RETRIES', 2, 0, 5))
        tokens = max(256, int(c.number('MAX_TOKENS', 4096)))
        key, base, model, thinking = c.get('DEEPSEEK_API_KEY'), c.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'), c.get('DEEPSEEK_MODEL', 'deepseek-flash'), None
        if role in {'summary', 'memory'}:
            summary_model = c.get('SUMMARY_MODEL').strip()
            if summary_model and c.get('SUMMARY_PROVIDER', 'deepseek').lower() == 'dashscope':
                key, base = c.get('DASHSCOPE_API_KEY'), c.get('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1')
                thinking = c.enabled('DASHSCOPE_ENABLE_THINKING', False)
            model = summary_model or model
            tokens = None if c.enabled('SUMMARY_UNRESTRICTED', True) else int(bounded(c, 'SUMMARY_MAX_TOKENS', 8000, 500, 16000))
            timeout = bounded(c, 'SUMMARY_REQUEST_TIMEOUT_SECONDS', 900, 60, 3600)
            concurrency = 1 if role == 'memory' else int(bounded(c, 'SUMMARY_CONCURRENCY', 2, 1, 3))
        elif role == 'sticker-filter':
            model, tokens, concurrency, timeout = 'deepseek-flash', None, 1, max(180, timeout)
        elif role == 'sticker-search':
            model = c.get('STICKER_SEARCH_MODEL').strip() or model
            concurrency, retries, timeout = 1, 1, max(60, timeout)
        elif role in {'vision', 'sticker-tag', 'summary-vision'}:
            provider = c.get('VISION_PROVIDER', 'dashscope') if role == 'vision' else c.get('STICKER_TAG_PROVIDER', 'auto') if role == 'sticker-tag' else 'dashscope'
            chain = ['dashscope', 'deepseek', 'custom'] if provider == 'auto' else [provider]
            key, base, model, thinking = ('', '', '', None)
            for candidate in chain:
                endpoint = self.vision_endpoint(candidate)
                if endpoint[0] and endpoint[1] and endpoint[2]:
                    key, base, model, thinking = endpoint; break
            tokens = int(bounded(c, 'VISION_MAX_TOKENS', 300, 64, 4000))
            if 'deepseek' in model.lower() and 'flash' in model.lower():
                tokens = max(2048, tokens)
            if role == 'summary-vision':
                model = c.get('SUMMARY_VISION_MODEL').strip() or model
                tokens = None if c.enabled('SUMMARY_UNRESTRICTED', True) else 500
                timeout = bounded(c, 'SUMMARY_REQUEST_TIMEOUT_SECONDS', 900, 60, 3600)
                concurrency = int(bounded(c, 'SUMMARY_CONCURRENCY', 2, 1, 3))
            elif role == 'sticker-tag':
                tokens, concurrency, timeout = None, 1, max(180, timeout)
        if not key or not base or not model:
            return None
        if not re.match(r'^qwen(?:3(?:\.\d+)?-(?:flash|plus|vl-(?:flash|plus))|-(?:flash|plus))(?:$|-)', model, re.I):
            thinking = None
        url = urlsplit(base)
        if url.scheme not in {'http', 'https'} or not url.hostname or url.username or url.password or url.query or url.fragment or re.search(r'[\x00-\x20\x7f]', base):
            raise ValueError('模型接口地址格式无效')
        try:
            url.port
        except ValueError as error:
            raise ValueError('模型接口端口无效') from error
        return dict(api_key=key, base_url=base, model=model, timeout=timeout, max_tokens=tokens, concurrency=concurrency, retries=retries, thinking=thinking)

    def get(self, role):
        spec = self.specification(role)
        if spec is None:
            return None
        signature = tuple(spec.items())
        saved = self.clients.get(role)
        if saved is None or saved[0] != signature:
            saved = (signature, self.factory(self.session, **spec))
            self.clients[role] = saved
        return saved[1]

    def role(self, name):
        return DynamicModel(self, name)


class DynamicModel:
    def __init__(self, pool, role):
        self.pool, self.role = pool, role

    def snapshot(self):
        return self.pool.get(self.role)

    def __bool__(self):
        return self.snapshot() is not None

    def __getattr__(self, key):
        target = self.snapshot()
        if target is None:
            if key in {'model', 'base_url'}:
                return ''
            raise ModelError('该用途的模型未配置，未发送模型请求')
        if key in {'chat', 'raw', 'describe'}:
            temperature = {'summary': 1., 'memory': 1., 'sticker-filter': .2,
                           'sticker-search': .3, 'summary-vision': .2}.get(self.role,
                bounded(self.pool.config, 'TEMPERATURE', 1.2, 0, 2))
            options = {'temperature': temperature}
            if self.role == 'summary' and key == 'chat' or self.role == 'summary-vision' and key == 'describe':
                # Quality/reference services also accept fake models; do not
                # rely on isinstance(proxy, ModelClient) for idle timeouts.
                options['stream'] = True
            return partial(getattr(target, key), **options)
        return getattr(target, key)


class DynamicSearch:
    def __init__(self, config):
        self.config, self.saved = config, None

    def snapshot(self):
        keys = ('WEB_SEARCH_ENABLED', 'WEB_SEARCH_PROVIDER', 'WEB_SEARCH_MODEL',
                'BAIDU_QIANFAN_API_KEY', 'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY')
        signature = tuple(self.config.get(key) for key in keys)
        if self.saved is None or self.saved[0] != signature:
            self.saved = (signature, WebSearch.from_config(self.config))
        return self.saved[1]

    def __bool__(self):
        return self.snapshot() is not None

    async def __call__(self, query):
        target = self.snapshot()
        if target is None:
            raise ModelError('联网搜索未配置或已关闭')
        return await target(query)


class Runtime:
    def __init__(self):
        self.tasks, self.workers = set(), {}
        self.closed, self.started, self.owns_session = False, False, False
        self.log = logging.getLogger('koukou.runtime')
        self.schedule_signature = None
        self.watch_signature = None
        self.restart_requested = asyncio.Event()

    @classmethod
    async def create(cls, config, *, session=None, onebot=None, preview=False, client_factory=ModelClient):
        self = cls()
        self.config, self.preview = config, preview
        self.lock = InstanceLock(config.data_dir,recover_stale=True).acquire()
        self.session = session
        try:
            if recover_session(config):
                config = Config(config.root, config.env_file, config.environ)
                if config.data_dir != self.lock.path.parent:
                    raise ValueError('恢复后的数据目录变化，请在新目录重新启动')
                self.config = config
            self.backup = Backup(config)
            self.backup.apply_pending()
            if session is None and not preview:
                import aiohttp
                self.session = aiohttp.ClientSession(trust_env=True)
                self.owns_session = True
            self.models = ModelPool(config, self.session, factory=client_factory)
            self.memory = Memory(config.data_dir, limit=int(bounded(config, 'HISTORY_LIMIT', 99, 4, 200)))
            self.long_memory = LongMemory(config.data_dir, None if preview else self.models.role('memory'), max_chars=int(bounded(config, 'LONG_MEMORY_MAX_CHARS', 6000, 300, 6000)))
            self.plugins = PluginManager(config.root, config)
            self.onebot = None if preview else onebot or OneBot(config.get('ONEBOT_WS_URL', 'ws://127.0.0.1:3001'), config.get('ONEBOT_ACCESS_TOKEN'), session=self.session)
            self.admin = Admin(config, self.plugins, self.memory, self.long_memory, onebot=self.onebot,
                               model=None if preview else self.models.role('summary'),
                               sticker_tag_model=None if preview else self.models.role('sticker-tag'))
            self.settings, self.stickers = self.admin.settings, self.admin.stickers
            self.log = getattr(self.admin, 'logger', self.log)
            self.admin.lifecycle.restart = self.restart_requested.set
            self.summaries, self.greetings, self.media = self.admin.summaries, self.admin.quiet_greetings, self.admin.media
            self.image_cache = ImageCache(config.data_dir / 'image-cache',
                max_bytes=int(bounded(config, 'VISION_CACHE_MAX_MB', 256, 1, 8192)*1024*1024),
                max_entries=int(bounded(config, 'VISION_CACHE_MAX_ENTRIES', 2000, 1, 100000)),
                max_image_bytes=int(bounded(config, 'VISION_MAX_IMAGE_BYTES', 6*1024*1024, 100000, 32*1024*1024)),
                ttl=bounded(config, 'VISION_CACHE_DAYS', 30, 1, 365)*86400000) if config.enabled('VISION_CACHE_ENABLED') else None
            self.rate_limiter = RateLimiter.from_config(config)
            self.learner, self.bot, self.scheduled, self.daily_ping, self.id_check = None, None, None, None, None
            self.web_search = None if preview else DynamicSearch(config)
            if not preview:
                self.learner = StickerLearner(config, self.onebot, self.stickers, self.models.role('sticker-filter'), self.models.role('sticker-tag'), self.image_cache,
                                               similar=self.admin.image_hasher.similar if self.admin.image_hasher.supported else None)
                vision = GroundedVisionClient(self.models.role('vision'),data_dir=config.data_dir,logger=self.log)
                self.bot = Bot(config, self.onebot, self.memory, model=self.models.role('chat'), long_memory=self.long_memory,
                    plugins=self.plugins, settings=self.settings, summary_service=self.summaries, stickers=self.stickers,
                    sticker_learner=self.learner, media_delivery=self.media, vision_model=vision, load_image=self.load_image,
                    image_cache=self.image_cache, web_search=self.web_search, web_sticker_search=self.search_sticker,
                    rate_limiter=self.rate_limiter)
                self.bot.sessions, self.bot.custom, self.bot.commands = self.admin.sessions, self.admin.custom, self.admin.commands
                if self.bot.actions:
                    self.bot.actions.registry = self.admin.commands
                self.media.quiet = self.bot.quiet
                self.summaries.vision_model = self.models.role('summary-vision')
                self.summaries.image_cache, self.summaries.load_image = self.image_cache, self.load_image
                self.scheduled = ScheduledCommands(config, self.onebot, self.admin.custom, self.memory, self.settings,
                                                   rate_limiter=self.rate_limiter, current=lambda key: not self.closed)
                self.daily_ping = DailyPing(config, self.onebot, self.memory, self.settings,
                                             rate_limiter=self.rate_limiter, current=lambda key: not self.closed)
                self.id_check = IdCheck(config, self.onebot, self.admin.commands,
                                         can_send=self.background_current)
                self.bot.daily_ping = self.admin.daily_ping = self.daily_ping
                self.bot.id_check = self.admin.id_check = self.id_check
                self.admin.scheduled = self.scheduled
                self.admin.watch = self.bot.watch
                self.admin.poke_diagnostics = self.bot.poke_diagnostics
                self.file_commands = self.bot.file_commands
                self.notifier = Notifier(config,self.onebot,config.data_dir/'notifications.json',logger=self.log,
                    current=lambda:not self.closed and self.onebot.online and not self.bot.quiet('p'+str(next(iter(sorted(config.ids('ADMIN_USERS'))),0))))
                for name in ('metrics', 'runtime_stats', 'reply_log'):
                    if hasattr(self.admin, name):
                        setattr(self.bot, name, getattr(self.admin, name))
                if not hasattr(self.admin, 'reply_log'):
                    self.admin.reply_log = self.bot.reply_log
                for service in (self.onebot, self.summaries.schedule, self.scheduled, self.daily_ping):
                    service.log = self.log
                self.onebot.on_event = self.dispatch
            return self
        except BaseException:
            await self.close()
            raise

    async def dispatch(self, event):
        if not self.closed and self.bot:
            self.refresh_policy()
            try:
                await self.bot.handle(event)
            except Exception as error:
                self.log.error('消息处理未完成：%s',str(error))
                alert = health_alert_for_error(str(error))
                if alert:
                    await self.notifier.notify(alert['key'],alert['text'])

    def background_current(self, key):
        return (not self.closed and not self.bot.quiet(key)
                and self.settings.get(key, {}).get('enabled') is not False
                and (not key.startswith('g') or int(key[1:]) not in self.config.ids('MUTED_GROUPS')))

    def refresh_policy(self):
        self.rate_limiter.per_hour = int(bounded(self.config, 'RATE_LIMIT_PER_HOUR', 25, 0, 100000))
        self.rate_limiter.min_gap_ms = bounded(self.config, 'RATE_LIMIT_MIN_GAP_MS', 4000, 0, 3600000)
        self.memory.limit = int(bounded(self.config, 'HISTORY_LIMIT', 99, 4, 200))

    async def configure_schedules(self):
        self.refresh_policy()
        signature = tuple(self.config.get(key) for key in ('SUMMARY_ENABLED', 'SUMMARY_TIMES', 'SUMMARY_FALLBACK_ENABLED'))
        if self.schedule_signature != signature:
            await self.summaries.schedule.close()
            if not self.closed:
                self.summaries.start()
                self.schedule_signature = signature
        watch = getattr(self.bot, 'watch', None)
        signature = tuple(self.config.get(key) for key in ('TARGET_WATCH_ENABLED', 'TARGET_WATCH_GROUP', 'TARGET_WATCH_USER'))
        if watch is not None and signature != self.watch_signature:
            prior = watch.task
            watch.stop()
            if prior:
                await asyncio.gather(prior, return_exceptions=True)
            watch.reset_pending()
            if not self.closed:
                watch.start()
                self.watch_signature = signature

    async def search_sticker(self, **kwargs):
        kwargs.pop('config', None)
        return await find_web_sticker(config=self.config, llm=self.models.role('sticker-search').snapshot(),
                                     vision=self.models.role('sticker-tag').snapshot(), **kwargs)

    async def load_image(self, image):
        url = str(image.get('url') or '')
        if not url and image.get('file'):
            result = await self.onebot.api('get_image', {'file': str(image['file'])})
            if isinstance(result, dict):
                url = str(result.get('url') or result.get('data', {}).get('url') or '')
        maximum = int(bounded(self.config, 'VISION_MAX_IMAGE_BYTES', 6*1024*1024, 100000, 32*1024*1024))
        data, mime = await fetch_public(url, maximum=maximum,
            timeout=bounded(self.config, 'VISION_IMAGE_TIMEOUT_MS', 20000, 5000, 180000)/1000)
        if not data or image_mime(data) != mime:
            raise ValueError('图片内容与格式不一致')
        return {'type': 'image_url', 'image_url': {'url': 'data:'+mime+';base64,'+base64.b64encode(data).decode()}}

    def track(self, task, name):
        self.tasks.add(task)
        self.workers[name] = task
        def done(value):
            self.tasks.discard(value)
            if self.workers.get(name) is value:
                self.workers.pop(name, None)
            if not value.cancelled() and value.exception():
                self.log.error('后台任务停止：%s (%s)', name, type(value.exception()).__name__)
        task.add_done_callback(done)
        return task

    def periodic(self, name, callback, interval, *, immediate=False):
        async def loop():
            if not immediate:
                await asyncio.sleep(interval())
            while not self.closed:
                try:
                    result = callback()
                    if inspect.isawaitable(result):
                        await result
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    # Log a type and role, never a provider's echoed body/URL.
                    self.log.warning('后台任务本轮失败：%s (%s)', name, type(exc).__name__)
                if self.closed:
                    break
                await asyncio.sleep(interval())
        return self.track(asyncio.create_task(loop()), name)

    async def maintain_memory(self):
        if not self.config.enabled('LONG_MEMORY_ENABLED'):
            return
        self.long_memory.max_chars = int(bounded(self.config, 'LONG_MEMORY_MAX_CHARS', 6000, 300, 6000))
        # Each key owns its own cancellation boundary; manual edits cancel the
        # child only, never the scheduler servicing other conversations.
        for key in list(self.long_memory.chats):
            if self.closed:
                return
            await asyncio.create_task(self.long_memory.summarize(key))

    async def start(self, *, connect=False, maintenance=False):
        if self.closed:
            raise RuntimeError('运行实例已关闭')
        if self.preview and (connect or maintenance):
            raise RuntimeError('预览实例禁止QQ连接和后台发送')
        if self.started:
            return self
        self.started = True
        if connect:
            self.track(asyncio.create_task(self.onebot.run()), 'onebot')
        if maintenance:
            await self.configure_schedules()
            self.scheduled.start()
            self.daily_ping.start()
            self.periodic('configuration', self.configure_schedules, lambda: 1)
            self.periodic('health', self.onebot.refresh_status, lambda: 30, immediate=True)
            self.periodic('quiet-greetings', self.greetings.tick, lambda: 1, immediate=True)
            self.periodic('media-cleanup', self.media.cleanup, lambda: 10)
            self.periodic('file-temp-cleanup', self.file_commands.cleanup, lambda: 600)
            self.periodic('long-memory', self.maintain_memory,
                          lambda: bounded(self.config, 'LONG_MEMORY_INTERVAL_MS', 600000, 60000, 86400000)/1000)
            self.periodic('backup', lambda: self.backup.run('auto'), lambda: 6*3600)
        return self

    async def close(self):
        if self.closed:
            return
        self.closed = True
        # Stop producers before their transport; cancellation is awaited before
        # releasing the instance lock, including failed startup.
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)
        try:
            greeting = getattr(self, 'greetings', None)
            if greeting is not None:
                greeting.stopped = True
            admin = getattr(self, 'admin', None)
            if admin is not None:
                for task in list(admin.background):
                    task.cancel()
                await asyncio.gather(*list(admin.background), return_exceptions=True)
            watch = getattr(getattr(self, 'bot', None), 'watch', None)
            if watch:
                prior = watch.task
                watch.stop(); watch.reset_pending()
                if prior:
                    await asyncio.gather(prior, return_exceptions=True)
            services = [getattr(self, name, None) for name in ('summaries', 'scheduled', 'daily_ping', 'learner', 'image_cache', 'onebot')]
            if getattr(admin, 'updates', None) is not None:
                services.append(admin.updates)
            errors = await asyncio.gather(*(service.close() for service in services if service is not None), return_exceptions=True)
            for error in errors:
                if isinstance(error, BaseException):
                    self.log.warning('关闭后台服务失败 (%s)', type(error).__name__)
            if getattr(admin, 'metrics', None) is not None:
                admin.metrics.close()
        finally:
            try:
                if self.owns_session and self.session is not None:
                    await self.session.close()
            finally:
                self.lock.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()
