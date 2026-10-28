# 原生运行验收入口

本入口用于明确选择的 Python 实例，不自动合并 main、停止旧机器人、修改计划任务或启用看门狗。默认裸 `run` 仍退出 `2`，`preview` 的隔离行为不变。生产切换仍须完成停写备份和回滚验收。

## 先只读检查

```powershell
.\.venv\Scripts\python -m koukou --root "D:\Koukou" --env-file "D:\Koukou-instance\bot.env" run --check --data-dir "D:\Koukou-instance\data" --log-dir "D:\Koukou-instance\logs" --profile example --port 8791
```

`--check` 输出配置文件位置、数据/日志目录、profile 和控制台开关/端口，不输出密钥，不创建目录、实例锁或计划文件，不连接 QQ。即使同时传入 `--enable-native`，检查模式也优先，不启动服务。

数据和日志必须是明确的绝对路径，由 `--data-dir`、`--log-dir` 或启动进程的 `BOT_DATA_DIR`、`BOT_LOG_DIR` 提供。仅在 `.env` 内填写这两个变量不能启用原生运行；这样可避免旧 JS 实例原本靠启动环境选目录，迁移时却默默进入空的 `data-python`。配置文件必须已经存在，可用全局 `--env-file` 或 `BOT_ENV_FILE` 选择。

## 明确选择运行

完成该实例的运行批准后，将上述命令的 `--check` 替换为 `--enable-native`。这一步会连接所选 OneBot 服务并启动该配置启用的后台任务，不能用生产配置做无发送预览。首次验收应使用明确隔离的实例配置。

未显式指定 `--port` 时读取 `ADMIN_PORT`。`ADMIN_ENABLED=0` 会关闭 HTTP 监听，原生消息处理和后台任务仍运行；这不改变 `preview` 的本地控制台。停止前台进程使用 Ctrl+C，或支持的平台信号；控制台重启由同一进程清理旧连接和任务后重新加载。实例锁未释放前不能启动第二份同目录实例。

旧 Windows `bot-start.bat`、停止器、重启器和 supervisor 仍面向 Node，不能用它们管理 Python。迁移入口不会调用这些脚本，也不自动接管旧任务。未来切换必须明确实例的配置、数据、日志和 profile，并保留恢复原 JS 实例的入口；不得按端口猜测并结束其他账号进程。

Python提供[独立启停入口](PYTHON-NATIVE-CONTROL.md)：前台启动前只读检查计划；管理停止核对实例代际并走本机鉴权通道，正常清理后验证进程及锁。它不覆盖上述旧脚本或注册计划任务。关闭HTTP监听时不支持管理式停止，应在原前台使用Ctrl+C，不能降级为强杀。

临时数据与回环协议测试覆盖：默认门禁、只读计划、绝对目录、已有配置、旧 Node 形状锁拒绝、HTTP 开关、原生连接、重启、信号停止、端口及实例锁清理。这些检查不代替生产停写快照。
