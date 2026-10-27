# Python 实例的明确启停

此入口管理明确指定的原生 Python 实例，不使用旧 Node 停止器，不结束端口对应的未知进程，不注册计划任务或启用看门狗。它不会合并 main，也不会接管正在运行的 JS 实例。

## Windows 包装入口

先在所选解释器安装 Python 包。仓库提供 `scripts/native-python.ps1`，所有实例路径与解释器必须是绝对路径，配置文件必须已经存在。以下示例只读检查启动计划，不创建目录、锁或启动 QQ 连接：

```powershell
powershell -NoProfile -File "D:\Koukou\scripts\native-python.ps1" -Action start -Python "D:\Koukou\.venv\Scripts\python.exe" -Root "D:\Koukou-instance" -EnvFile "D:\Koukou-instance\bot.env" -DataDir "D:\Koukou-instance\data" -LogDir "D:\Koukou-instance\logs" -Profile example
```

经确认后添加 `-Execute` 才会在前台运行原生实例。前台 Ctrl+C 会进入原生清理，不广播控制事件给其他进程。若需改变控制台端口，可传 `-Port 8791`；此后管理停止也必须使用同一端口。既有计划任务和隐藏 JS 启动入口不变。

停止也先只读检查：把 `-Action start` 换为 `-Action stop`，其余路径、profile 和端口保持与启动时相同。该检查只读实例锁并访问固定本机控制台，不写配置，也不发送 QQ 消息。添加 `-Execute` 才请求优雅停止。

## 不使用 PowerShell

同样的功能由原生 CLI 提供，可以直接调用安装该包的 Python：

```text
python -m koukou --root D:\Koukou-instance --env-file D:\Koukou-instance\bot.env stop-native --data-dir D:\Koukou-instance\data --log-dir D:\Koukou-instance\logs --profile example
```

默认只读；添加 `--execute` 才请求关闭。可使用 `--port` 选择启动时明确指定的控制台端口，`--timeout 30` 调整请求确认后的退出等待（1～300 秒）。这只限制管理工具的等待，不设置群总结的总时限。

## 如何保证实例归属

停止工具仅访问固定 `127.0.0.1`，不使用系统代理或跟随重定向。必须先确认数据目录里的锁属于 Python，且控制台给出的 PID、profile、配置/数据/日志路径和锁代际身份全部一致。旧 Node 锁、预览控制台、未绑定原生宿主的独立 Admin、错 profile 或替换过的锁均不接受停止。

实际关闭使用同一控制台下发的页面令牌，经既有 Host、Origin、JSON 和令牌检查后，再检查目标代际。服务先正常返回确认，再通知宿主清理。延迟回调执行时仍复核原代际的锁归属；期间发生重启或锁替换，旧请求不会关闭新代。

工具确认原 PID 已退出且旧锁释放后，才报告 `stopped: true`。Windows 使用只读进程句柄等待状态，Linux 识别已退出但尚未回收的子进程。若连接失败、回执不明、锁损坏或退出超时，会明确报错；不会重复发送关闭请求、删除锁或改用强制终止。

`ADMIN_ENABLED=0` 时没有管理式 HTTP 停止通道，`stop-native` 明确拒绝；应在原前台使用 Ctrl+C。不要用旧 `stop-old-bot.ps1` 管理 Python，也不要因为停止工具超时就启动第二份同目录实例。

以上是原生入口与隔离测试能力，不代表已经切换生产。正式替换仍需保留已核验的原实例恢复入口和完整数据快照。
