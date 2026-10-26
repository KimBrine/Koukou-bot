"""Console hosts with one owner for restart and shutdown cleanup.

Preview never starts OneBot or background senders. The native host is reusable
for isolated protocol fixtures and the future cutover; it is deliberately not
connected to the public CLI until the independent migration gate is satisfied.
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


async def serve_native(config, port=8787, *, stop=None, ready=None,
                       handle_signals=True, runtime_factory=Runtime.create):
    """Host the complete native runtime; not exposed by the gated public CLI."""
    await _serve_console(config, port, preview=False, stop=stop, ready=ready,
                         handle_signals=handle_signals, runtime_factory=runtime_factory)


async def _serve_console(config, port, *, preview, stop, ready,
                         handle_signals, runtime_factory):
    """Serve either mode, releasing HTTP resources before its instance lock.

    ``stop`` and ``ready`` let isolated acceptance fixtures use this same host.
    Port 0 is permitted only internally and pins the selected port on restart.
    """
    from aiohttp import web
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise ValueError('控制台端口无效')
    stop = stop if stop is not None else asyncio.Event()
    generation = 0

    async def host():
        nonlocal config, port, generation
        while not stop.is_set():
            runtime = await runtime_factory(config, preview=preview)
            runner = None
            waiters = []
            try:
                runner = web.AppRunner(runtime.admin.app(), shutdown_timeout=5)
                await runner.setup()
                site = web.TCPSite(runner, '127.0.0.1', port)
                await site.start()
                port = site._server.sockets[0].getsockname()[1]
                if not preview:
                    await runtime.start(connect=True, maintenance=True)
                generation += 1
                if ready is None:
                    mode = '仅预览，QQ连接已禁用' if preview else '原生后端实例，尚未切换main'
                    print(f'Python迁移控制台：http://127.0.0.1:{port}（{mode}）', flush=True)
                else:
                    result = ready(runtime, port, generation)
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
