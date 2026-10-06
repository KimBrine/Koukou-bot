# NapCat 启动中心

提供启动窗口、QQ 实际在线检查和计划任务入口。NapCat、QQ 与 DLL 需单独安装。登录凭据从部署配置读取。

## 配置

1. 将 `launcher.example.json` 复制为 `launcher.local.json`。
2. 设置 `napcatDir`（安装目录）、`botEnvFile`（机器人实例 `.env`）和 `taskName`（已有 NapCat 计划任务）。`account` 可留空。
3. 双击 `napcat-control.vbs` 打开窗口。窗口从 NapCat 的 `napcat/config/webui.json` 读取 WebUI Token，并带入登录页。
4. 如需使用提供的启动入口，将计划任务操作指向 `wscript.exe`，参数为 `napcat-boot-hidden.vbs` 的完整路径；确保一个账号只运行一个 NapCat 实例。

`launcher.local.json` 与 `.env.napcat` 被 Git 忽略。需要快速登录参数时，复制 `.env.napcat.example` 为 `.env.napcat` 并填写；首次登录或需要验证时使用扫码流程。

## 文件

| 文件 | 作用 |
| --- | --- |
| `napcat-control.ps1` / `.vbs` | 启动窗口与隐藏入口 |
| `napcat-status.ps1` | 区分进程存在、OneBot 连接与 QQ 实际在线 |
| `launcher-settings.ps1` | 加载目录、实例配置及任务名 |
| `napcat-boot.ps1` / `napcat-boot-hidden.vbs` | 从独立配置读取路径与登录参数的启动入口 |

在线核验会匹配 OneBot 地址，并读取机器人 `.env` 中 `ADMIN_PORT` 对应控制台的实际连接结果。
