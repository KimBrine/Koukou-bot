# Windows 部署与本机目录

## 项目分成三部分

| 部分 | 位置/内容 | Git 管理 |
| --- | --- | --- |
| Koukou 源码 | `src/`、`scripts/`、人格文本、控制台页面及维护脚本 | 是 |
| NapCat 自定义启动中心 | `integrations/napcat/` | 是 |
| 账号配置与运行数据 | `.env`、当前账号的 `data/` 和 `logs/`、NapCat 登录状态及缓存 | 仅保留本地 |

NapCat 和 QQ 客户端单独安装，仓库提供对接代码和自定义启动界面。

## 在新目录运行

需要 Git、Node.js 22 以上和已配置 OneBot 正向 WebSocket 的 NapCat。

```powershell
git clone https://github.com/KimBrine/Koukou. Koukou
cd Koukou
Copy-Item .env.example .env
notepad .env
npm start
```

填写 API Key、OneBot 地址/Token、白名单和控制台端口。项目使用 Node.js 内置能力，无需下载 npm 依赖。窗口控制台的地址由 `ADMIN_PORT` 决定；启用控制台需要 `ADMIN_ENABLED=1`。

NapCat 需设置对应的正向 WebSocket 服务端；自动 +1 还需要启用 `reportSelfMessage`。首次 QQ 登录需要人工扫码或验证码。

## 当前电脑的一份代码、独立账号数据

本机使用的源码目录：

```text
E:\Deepseek Harness Workplace\deepseek-qq-bot
```

当前账号的配置、数据和日志目录：

```text
E:\Deepseek Harness Workplace\deepseek-qq-bot-2
```

启动脚本设置以下变量，加载共享代码：

```powershell
$env:BOT_ENV_FILE = 'E:\Deepseek Harness Workplace\deepseek-qq-bot-2\.env'
$env:BOT_DATA_DIR = 'E:\Deepseek Harness Workplace\deepseek-qq-bot-2\data'
$env:BOT_LOG_DIR = 'E:\Deepseek Harness Workplace\deepseek-qq-bot-2\logs'
$env:BOT_PROFILE = 'new'
node src/index.js --profile=new
```

这段是说明现有启动方式的示例；已有机器人运行时，使用桌面入口或控制台操作，避免另外启动一个同账号进程。现有 `bot-start-2.bat`、VBS 和计划任务维护脚本保留了这台电脑的路径与任务名；移到新电脑时需调整这些入口，或先用 `npm start` 手动运行。

## 两个桌面入口

- **Koukou 控制台**：源码是 `src/admin/ui.html` 与 `src/admin/server.js`，窗口入口是 `console-app.ps1` / `启动控制台2.vbs`。
- **NapCat 启动中心**：源码与配置说明在 [integrations/napcat](../integrations/napcat/README.md)。本机 `launcher.local.json` 连接现有安装与当前账号配置。

修改 Node.js 代码后，在控制台点「重启机器人」加载新版本。修改 NapCat 启动窗口代码后重新打开窗口即可。更新 Git 源码不会自动重新登录 QQ。

## 检查与诊断

```powershell
npm test
npm run check:repo
```

`npm test` 只运行明确挑选的本地模拟，覆盖群总结、定时补发、真实在线判定、自动 +1、图片缓存和白名单管理。`scripts/` 中其他历史探针可调用真实 QQ 或模型；先阅读各脚本顶部说明，再手动运行。

个人配置、群聊记录、记忆、图片和登录态需要另外备份到自己的存储；Git 仓库提供可恢复的源码版本。
