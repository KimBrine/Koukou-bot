"""Acceptance worker imported only from a newly built/installed wheel."""
import asyncio
from contextlib import redirect_stdout, redirect_stderr
import hashlib
from io import StringIO
import json
from pathlib import Path
import sys


installed, instance = (Path(value).resolve() for value in sys.argv[1:3])
sys.path.insert(0, str(installed))
import koukou
from koukou.__main__ import default_root, main
from koukou.config import Config
from koukou.plugins import PluginManager
from koukou.resources import frontend_assets, install_bundled_plugins, migration_contract
from koukou.runtime import Runtime


def digest_tree(root):
    return {str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*') if path.is_file()}


async def check():
    from aiohttp.test_utils import TestClient, TestServer
    assert Path(koukou.__file__).is_relative_to(installed), koukou.__file__
    assert default_root() == instance, 'installed default root depends on cwd/source'
    before = digest_tree(installed)
    captured = StringIO()
    with redirect_stdout(captured):
        assert main(['migration']) == 0
    assert json.loads(captured.getvalue())['ready'] is False
    with redirect_stderr(StringIO()):
        assert main(['run']) == 2, 'run migration gate unexpectedly disabled'
    result = install_bundled_plugins(instance)
    assert len(result['installed']) == 4
    manager = PluginManager(instance)
    answer = await manager.run('calc', ['1+2'])
    assert answer['ok'] and answer['stdout'] == '3', answer
    manager.create('sdkfixture')
    answer = await manager.run('sdkfixture', ['中文'])
    assert answer['ok'] and answer['stdout'] == '收到：中文', answer
    assert frontend_assets(instance).is_relative_to(installed)
    assert migration_contract(instance).is_relative_to(installed)
    config = Config(instance, instance/'preview.env', environ={})
    runtime = await Runtime.create(config, preview=True)
    client = TestClient(TestServer(runtime.admin.app()))
    try:
        await client.start_server()
        for path in ('/','/ui.css','/app.js','/command-center.js','/sticker-upload.js'):
            response = await client.get(path)
            assert response.status == 200, (path, response.status, await response.text())
            assert len(await response.read()) > 50
        response = await client.get('/api/state')
        assert response.status == 200, await response.text()
        state = await response.json()
        assert not state['bot']['online'] and not state['migration']['ready']
    finally:
        await client.close()
        await runtime.close()
    assert digest_tree(installed) == before, 'runtime wrote into the installed wheel'
    assert not (instance/'data-python'/'bot.lock').exists()
    print(json.dumps({'ok':True, 'checks':['wheel resources','stable writable instance',
        'migration gate','bundled plugins','UTF-8 SDK subprocess',
        'five console assets over HTTP','preview state','immutable installed files']}, ensure_ascii=False))


asyncio.run(check())
