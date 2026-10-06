# Windows 部署

## 环境与接口

安装 Git、Node.js 22 以上、QQ 与 NapCat，并在 NapCat 配置 OneBot 11 正向 WebSocket 服务端。客户端、安装目录和 QQ 登录态由部署者管理。

```powershell
git clone https://github.com/KimBrine/Koukou.git
cd Koukou
Copy-Item .env.example .env
notepad .env
npm start
```

填写接口密钥和 OneBot 地址/Token。控制台固定监听回环地址 `127.0.0.1`，默认端口 `8787`；启用需要 `ADMIN_ENABLED=1`。

## 桌面控制台

`启动控制台2.vbs` 以隐藏的 PowerShell 入口打开 `console-app.ps1`。脚本根据自己的目录定位代码，再读取 `.env` 中的控制台端口；控制台未运行时尝试启动指定的计划任务。

需要指定实例配置或计划任务名时：

```powershell
Copy-Item windows.example.json windows.local.json
notepad windows.local.json
```

`botEnvFile` 可使用相对路径或绝对路径；`botProfile`、`botTaskName`、`napcatDir` 和 `napcatTaskName` 按部署环境填写。`windows.local.json` 被 Git 忽略。

也可以显式传入：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\console-app.ps1 -EnvFile .\.env -TaskName DeepSeekQQBot
```

## 后台启动与计划任务

`bot-start.bat` 默认加载仓库中的 `.env`，使用 `data/`、`logs/` 和 `main` 实例名。`bot-start-2.bat` 保留为兼容入口；`bot-new-start-hidden.vbs` 在隐藏窗口中调用它。

独立实例可创建被 Git 忽略的 `bot-start.local.bat`，覆盖以下变量。路径是示例，需替换为自己的部署目录：

```bat
set "BOT_ENV_FILE=C:\KoukouProfiles\example\.env"
set "BOT_DATA_DIR=C:\KoukouProfiles\example\data"
set "BOT_LOG_DIR=C:\KoukouProfiles\example\logs"
set "BOT_PROFILE=example"
```

在任务计划程序中创建机器人任务，操作指向 `wscript.exe`，参数为 `bot-new-start-hidden.vbs` 的完整路径。把实际任务名填写到实例 `.env` 的 `BOT_TASK_NAME` 和 `windows.local.json` 的 `botTaskName`。

可用 `bot-supervisor.ps1` 定期检查进程；它只在进程不存在时启动指定任务，多实例时报告异常。`-DryRun` 仅报告启动动作，不启动任务。NapCat 目录未设置时跳过 NapCat 的进程检查。

## 多账号实例

共享一份源码，分别设置以下环境变量：

| 变量 | 用途 |
| --- | --- |
| `BOT_ENV_FILE` | 该账号的 `.env` |
| `BOT_DATA_DIR` | 该账号的消息、记忆与状态文件 |
| `BOT_LOG_DIR` | 该账号的日志 |
| `BOT_PROFILE` | 独立实例名 |

每个实例需使用独立的 OneBot 端口、控制台端口、数据目录、日志目录和计划任务。避免同账号同时启动多个进程。

## NapCat 与连接检查

自定义启动中心的配置见 [NapCat 集成说明](../integrations/napcat/README.md)。机器人 `.env` 中的 `NAPCAT_DIR` 和 `NAPCAT_TASK_NAME` 用于控制台重启指定 NapCat 实例；未配置目录时控制台会提示设置。

首次登录或重新验证需人工扫码/验证码。修改代码后重新启动机器人；修改启动窗口代码后重新打开窗口。更新代码不会自动登录 QQ。

## 数据与排查

- 机器人日志默认位于 `logs/bot.log`；批处理入口输出位于 `logs/console.log`。
- NapCat 的登录/启动输出位于安装目录的 `napcat-console.log`。
- 登录态、接口密钥、聊天记录、记忆和缓存属于部署数据，不纳入源码仓库。
- 控制台分别显示进程、OneBot 和 QQ 实际连接状态。没有消息回复时，可先核对事件是否到达及静音/安静时段设置。

离线验证命令：`npm test` 与 `npm run check:repo`。
