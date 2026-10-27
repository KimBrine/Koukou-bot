"""Exercise the real opt-in CLI with local fixtures and a scoped stop signal."""
import asyncio
import signal
import sys

from koukou import console_server
from koukou.__main__ import main


original = console_server.serve_native


async def controlled(*args, **kwargs):
    async def stop_from_stdin():
        await asyncio.to_thread(sys.stdin.readline)
        # Run on this process's event-loop thread. No broadcast to Windows
        # consoles or any other bot process is involved.
        signal.raise_signal(signal.SIGTERM)

    reader = asyncio.create_task(stop_from_stdin())
    try:
        await original(*args, **kwargs)
    finally:
        await reader


console_server.serve_native = controlled
raise SystemExit(main(sys.argv[1:]))
