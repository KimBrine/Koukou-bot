"""Console hosts with one owner for restart and shutdown cleanup.

Preview never starts OneBot or background senders. Native startup requires an
explicit CLI opt-in and instance paths; legacy production launchers stay separate.
"""
import asyncio
from contextlib import contextmanager
import inspect
import signal
import threading

from .config import Config
from .runtime import Runtime
from .lifecycle import finish_cleanup


@contextmanager
def shutdown_signals(stop):
    """Use Python handlers on Windows too; event-loop signal APIs are Unix-only."""
    saved = {}
    if threading.current_thread() is threading.main_thread():
        loop = asyncio.get_running_loop()
        for name in ('SIGINT', 'SIGTERM', 'SIGBREAK'):
            value = getattr(signal, name, None)
            if value is not None:
                saved[value] = signal.getsignal(value)
                signal.signal(value, lambda *_: loop.call_soon_threadsafe(stop.set))
    try:
        yield
    finally:
        for value, handler in saved.items():
            signal.signal(value, handler)


async def serve_preview(config, port=8790, *, stop=None, ready=None,
                        handle_signals=True, runtime_factory=Runtime.create):
    """Host a console without a QQ connection, models, or background senders."""
    await _serve_console(config, port, preview=True, stop=stop, ready=ready,
                         handle_signals=handle_signals, runtime_factory=runtime_factory)


async def serve_native(config, port=None, *, stop=None, ready=None,
                       handle_signals=True, runtime_factory=Runtime.create):
    """Host native tasks, honoring ADMIN_ENABLED and the configured ADMIN_PORT."""
    await _serve_console(config, port, preview=False, stop=stop, ready=ready,
                         handle_signals=handle_signals, runtime_factory=runtime_factory)


async def _serve_console(config, port, *, preview, stop, ready,
                         handle_signals, runtime_factory):
    """Serve either mode, releasing HTTP resources before its instance lock.

    ``stop`` and ``ready`` let isolated acceptance fixtures use this same host.
    Port 0 is permitted only internally and pins the selected port on restart.
    """
    from aiohttp import web
    if port is not None and (isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535):
        raise ValueError('控制台端口无效')
    stop = stop if stop is not None else asyncio.Event()
    generation = 0

    async def host():
        nonlocal config, port, generation
        while not stop.is_set():
            from .native_cli import console_port
            enabled = preview or config.enabled('ADMIN_ENABLED')
            active_port = console_port(config) if port is None else port
            runtime = await runtime_factory(config, preview=preview)
            runner = None
            waiters = []
            try:
                if enabled:
                    runner = web.AppRunner(runtime.admin.app(), shutdown_timeout=5)
                    await runner.setup()
                    site = web.TCPSite(runner, '127.0.0.1', active_port)
                    await site.start()
                    active_port = site._server.sockets[0].getsockname()[1]
                    if port == 0:
                        port = active_port
                if not preview:
                    await runtime.start(connect=True, maintenance=True)
                generation += 1
                if ready is None:
                    mode = '仅预览，QQ连接已禁用' if preview else '原生后端实例，尚未切换main'
                    address = f'http://127.0.0.1:{active_port}' if enabled else '已按ADMIN_ENABLED关闭HTTP监听'
                    print(f'Python迁移控制台：{address}（{mode}）', flush=True)
                else:
                    result = ready(runtime, active_port, generation)
                    if inspect.isawaitable(result):
                        await result
                waiters = [asyncio.create_task(stop.wait()),
                           asyncio.create_task(runtime.restart_requested.wait())]
                await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in waiters:
                    task.cancel()
                async def cleanup():
                    await asyncio.gather(*waiters, return_exceptions=True)
                    try:
                        if runner is not None:
                            await runner.cleanup()
                    finally:
                        await runtime.close()
                # HTTP cleanup must finish before the runtime releases its
                # lock, including a second Ctrl-C during shutdown.
                await finish_cleanup(cleanup())
            if not stop.is_set():
                config = Config(config.root, config.env_file, config.environ)

    if handle_signals:
        with shutdown_signals(stop):
            await host()
    else:
        await host()
