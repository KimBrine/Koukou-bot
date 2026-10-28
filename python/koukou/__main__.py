"""Explicit CLI entry point; inspection and plugin creation never connect to QQ."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
from .config import Config
from .plugins import PluginManager
from .migration import report


def default_root():
    from .resources import default_instance_root
    return default_instance_root()


async def serve(config, port):
    from .console_server import serve_preview
    await serve_preview(config,port)


def preview_config(root):
    root=Path(root).resolve()
    # The default preview must never edit the production .env or its data paths.
    return Config(root,root/'data-python'/'preview.env',environ={
        'BOT_DATA_DIR':str(root/'data-python'),'BOT_LOG_DIR':str(root/'logs-python')})


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Koukou原生Python后端迁移分支")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--env-file", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    migration = commands.add_parser("migration", help="查看迁移清单，不连接QQ")
    migration.add_argument("--require-complete", action="store_true")
    audit = commands.add_parser('audit-data',help='只读检查指定实例的旧数据，不迁移或连接QQ')
    audit.add_argument('--data-dir',required=True,type=Path)
    audit.add_argument('--persona-dir',type=Path)
    audit.add_argument('--source-env',type=Path,help='只读检查的实例配置，不写入或加载服务')
    snapshot=commands.add_parser('snapshot-data',help='复制数据到全新私有快照目录，不修改源实例')
    snapshot.add_argument('--data-dir',type=Path,required=True)
    snapshot.add_argument('--destination',type=Path,required=True)
    snapshot.add_argument('--source-env',type=Path)
    snapshot.add_argument('--exclude',action='append',default=[],help='精确相对路径，记入快照范围；可重复')
    verify=commands.add_parser('verify-snapshot',help='只读核对快照文件集合与SHA-256')
    verify.add_argument('--snapshot',type=Path,required=True)
    rehearsal=commands.add_parser('rehearse-restore',help='将已校验快照复制到全新演练目录，不覆盖现有实例')
    rehearsal.add_argument('--snapshot',type=Path,required=True)
    rehearsal.add_argument('--destination',type=Path,required=True)
    preview = commands.add_parser("preview", help="启动本地Python控制台预览，不连接QQ")
    preview.add_argument("--port", type=int, default=8790)
    connect = commands.add_parser("run", help="显式启用原生运行，或只读检查启动计划")
    connect.add_argument('--enable-native', action='store_true', help='明确授权此进程连接QQ并启动后台任务')
    connect.add_argument('--check', action='store_true', help='只读输出启动计划，不写数据、不连接QQ')
    connect.add_argument('--data-dir', type=Path)
    connect.add_argument('--log-dir', type=Path)
    connect.add_argument('--profile')
    connect.add_argument('--port', type=int)
    stopping = commands.add_parser('stop-native', help='只读核对原生实例，显式--execute才优雅停止')
    stopping.add_argument('--data-dir', type=Path)
    stopping.add_argument('--log-dir', type=Path)
    stopping.add_argument('--profile')
    stopping.add_argument('--port', type=int)
    stopping.add_argument('--execute', action='store_true')
    stopping.add_argument('--timeout', type=float, default=15)
    commands.add_parser("settings", help="输出启动器需要的本地端口，不连接QQ")
    plugins = commands.add_parser("plugin", help="创建、列出、运行Python插件")
    sub = plugins.add_subparsers(dest="operation", required=True)
    new = sub.add_parser("new")
    new.add_argument("name")
    new.add_argument("--description", default="自定义Python指令")
    sub.add_parser("list")
    sub.add_parser('install-bundled',help='安装随附插件，保留所有已有同名文件')
    run = sub.add_parser("run")
    run.add_argument("name")
    run.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.command=='audit-data':
            from .migration_audit import audit_data
            status=audit_data(args.data_dir,persona_dir=args.persona_dir,env_file=args.source_env or args.env_file)
            print(json.dumps(status,ensure_ascii=False,indent=2))
            return 0 if status['compatible'] else 1
        if args.command in {'snapshot-data','verify-snapshot','rehearse-restore'}:
            from .migration_snapshot import create_snapshot,verify_snapshot,derive_rehearsal
            if args.command=='snapshot-data':
                status=create_snapshot(args.data_dir,args.destination,exclude=args.exclude,env_file=args.source_env)
            elif args.command=='verify-snapshot':status=verify_snapshot(args.snapshot)
            else:status=derive_rehearsal(args.snapshot,args.destination)
            print(json.dumps(status,ensure_ascii=False,indent=2))
            return 0 if status['ok'] else 1
        args.root=args.root or default_root()
        if args.command == 'settings':
            from urllib.parse import urlsplit
            config = Config(args.root, args.env_file)
            url = urlsplit(config.get('ONEBOT_WS_URL', 'ws://127.0.0.1:3001'))
            if url.hostname not in {'127.0.0.1', 'localhost', '::1'} or url.scheme not in {'ws', 'wss'}:
                print('本地启动入口只用于本地 OneBot', file=sys.stderr)
                return 1
            port = url.port or (443 if url.scheme == 'wss' else 80)
            if not 0 < port <= 65535:
                print('OneBot 端口无效', file=sys.stderr)
                return 1
            print(f'ONEBOT_PORT={port}')
            print(f'CONSOLE_PORT={int(config.number("ADMIN_PORT", 8787))}')
            if config.get('LLBOT_QQ'):
                print('LLBOT_QQ=' + config.get('LLBOT_QQ'))
            if config.enabled('LLBOT_DEBUG', False):
                print('LLBOT_DEBUG=1')
            return 0
        if args.command == 'stop-native':
            from .native_cli import resolve_native_config
            from .native_control import stop_native
            config = resolve_native_config(args.root, args.env_file, data_dir=args.data_dir,
                log_dir=args.log_dir, profile=args.profile, port=args.port)
            value = asyncio.run(stop_native(config, port=args.port, execute=args.execute, timeout=args.timeout))
            print(json.dumps(value, ensure_ascii=False, indent=2))
            return 0
        if args.command == 'run':
            if not args.enable_native and not args.check:
                print("完整后端迁移及行为等价验证尚未完成，拒绝连接QQ；可用 preview 检查迁移控制台。原生验收需显式指定--enable-native。", file=sys.stderr)
                return 2
            from .native_cli import resolve_native_config, native_plan
            config = resolve_native_config(args.root, args.env_file, data_dir=args.data_dir,
                log_dir=args.log_dir, profile=args.profile, port=args.port)
            if args.check:
                print(json.dumps(native_plan(config, args.port), ensure_ascii=False, indent=2))
                return 0
            from .console_server import serve_native
            asyncio.run(serve_native(config, args.port))
            return 0
        config = preview_config(args.root) if args.command=='preview' and args.env_file is None else Config(args.root, args.env_file)
        if args.command == "migration":
            status = report(config.root)
            print(json.dumps(status, ensure_ascii=False, indent=2))
            return 1 if args.require_complete and not status["ready"] else 0
        if args.command == "preview":
            if not 1024 <= args.port <= 65535:
                raise ValueError("预览端口必须在1024~65535之间")
            asyncio.run(serve(config, args.port))
            return 0
        if args.operation=='install-bundled':
            from .resources import install_bundled_plugins
            print(json.dumps(install_bundled_plugins(config.root),ensure_ascii=False,indent=2));return 0
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
