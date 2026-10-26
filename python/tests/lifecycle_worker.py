"""Child-process fixture for the real preview host. Never connects to QQ."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys

from koukou.config import Config
from koukou.console_server import serve_preview


async def main():
    root = Path(sys.argv[1])
    config = Config(root, root / 'preview.env', environ={
        'BOT_DATA_DIR': str(root / 'isolated-data'),
        'BOT_LOG_DIR': str(root / 'isolated-logs'),
        # A configured address must still be completely unused in preview.
        'ONEBOT_WS_URL': 'ws://127.0.0.1:1/never-connect',
        'DEEPSEEK_API_KEY': 'offline-fixture',
    })
    stop = asyncio.Event()

    def ready(runtime, port, generation):
        assert runtime.preview and runtime.onebot is None and runtime.session is None
        assert runtime.bot is None and not runtime.tasks
        print(json.dumps({'port': port, 'generation': generation, 'pid': os.getpid(),
                          'lockToken': runtime.lock.token}), flush=True)

    async def control():
        # One command releases the executor thread before shutdown.
        command = (await asyncio.to_thread(sys.stdin.readline)).strip()
        if command == 'signal':
            # Exercise the real installed signal handler without broadcasting
            # console control events to unrelated Windows processes.
            signal.raise_signal(signal.SIGINT)
        elif command == 'crash':
            os._exit(73)
        else:
            stop.set()

    reader = asyncio.create_task(control())
    try:
        await serve_preview(config, 0, stop=stop, ready=ready)
    finally:
        await reader


if __name__ == '__main__':
    asyncio.run(main(), debug=True)
