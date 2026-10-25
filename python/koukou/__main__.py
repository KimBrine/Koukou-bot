"""Explicit CLI entry point; inspection and plugin creation never connect to QQ."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
from .config import Config
from .plugins import PluginManager
from .memory import Memory, LongMemory
from .migration import report


def default_root():
    path = Path(__file__).resolve().parents[2]
    return path if (path / "src" / "admin" / "ui.html").exists() else Path.cwd()


async def serve(config, port):
    from aiohttp import web
    from .admin import Admin
    from .state import InstanceLock
    from .sessions import recover_session
    from .backup import Backup
    with InstanceLock(config.data_dir):
        if recover_session(config):
            config = Config(config.root, config.env_file, config.environ)
        Backup(config).apply_pending()
        admin = Admin(config, PluginManager(config.root, config), Memory(config.data_dir), LongMemory(config.data_dir))
        runner = web.AppRunner(admin.app())
        await runner.setup()
        try:
            await web.TCPSite(runner, "127.0.0.1", port).start()
            print(f"Python迁移控制台：http://127.0.0.1:{port}（仅预览，QQ连接已禁用）", flush=True)
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Koukou原生Python后端迁移分支")
    parser.add_argument("--root", type=Path, default=default_root())
    parser.add_argument("--env-file", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    migration = commands.add_parser("migration", help="查看迁移清单，不连接QQ")
    migration.add_argument("--require-complete", action="store_true")
    preview = commands.add_parser("preview", help="启动本地Python控制台预览，不连接QQ")
    preview.add_argument("--port", type=int, default=8790)
    connect = commands.add_parser("run", help="迁移验收完成后才能启用的运行入口")
    plugins = commands.add_parser("plugin", help="创建、列出、运行Python插件")
    sub = plugins.add_subparsers(dest="operation", required=True)
    new = sub.add_parser("new")
    new.add_argument("name")
    new.add_argument("--description", default="自定义Python指令")
    sub.add_parser("list")
    run = sub.add_parser("run")
    run.add_argument("name")
    run.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    config = Config(args.root, args.env_file)
    try:
        if args.command == "migration":
            from .admin import Admin
            admin = Admin(config, PluginManager(config.root, config), Memory(config.data_dir), LongMemory(config.data_dir))
            status = admin.get_migration({})
            print(json.dumps(status, ensure_ascii=False, indent=2))
            return 1 if args.require_complete and not status["ready"] else 0
        if args.command == "run":
            print("完整后端迁移及行为等价验证尚未完成，拒绝连接QQ；可用 preview 检查迁移控制台。", file=sys.stderr)
            return 2
        if args.command == "preview":
            if not 1024 <= args.port <= 65535:
                raise ValueError("预览端口必须在1024~65535之间")
            asyncio.run(serve(config, args.port))
            return 0
        manager = PluginManager(config.root, config)
        if args.operation == "new":
            item = manager.create(args.name, args.description)
            print(f"已创建：{item['path']}\n编辑handle函数，再用 koukou plugin run {args.name} 参数 测试。")
        elif args.operation == "list":
            print(json.dumps(manager.list(), ensure_ascii=False, indent=2))
        elif args.operation == "run":
            # Use JSON quoting for each argument without letting a shell interpret it.
            from .plugins import decode_result
            value = asyncio.run(manager.run(args.name, args.args))
            print(json.dumps(decode_result(value), ensure_ascii=False, indent=2))
            return 0 if value["ok"] else 1
        return 0
    except (ValueError, RuntimeError, OSError, SyntaxError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
