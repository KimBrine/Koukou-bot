# NapCat 启动中心源码

这里保存 Koukou 自己维护的启动窗口、真实在线状态检查及启动脚本。NapCat、QQ 客户端及 DLL 由各自项目提供，需单独安装；QQ 登录态、WebUI Token 和密码散列保存在安装目录或本机配置中。

## 配置

1. 把 `launcher.example.json` 复制为 `launcher.local.json`。
2. 填写 `napcatDir`（NapCat 安装目录）、`botEnvFile`（当前机器人实例的 `.env`）和 `taskName`（已有 NapCat 计划任务名）。`account` 可留空，首次用扫码登录。
3. 双击 `napcat-control.vbs` 打开启动中心。状态检查区分「进程存在」「OneBot 已连接」与「QQ 实际在线」。
4. 如需使用仓库中的启动脚本，可把计划任务操作指向 `wscript.exe "本目录\napcat-boot-hidden.vbs"`。先关闭旧实例，确保一个账号只有一个 NapCat 实例，再切换启动方式。

`launcher.local.json`、`.env.napcat` 都被 Git 忽略。窗口从 NapCat 本机 `napcat/config/webui.json` 读取登录 Token，打开登录页时自动带入。

## 本机现状

当前桌面启动中心使用此目录的源码，配置文件在本地；已有 `NapCatQQ2` 计划任务仍使用原安装目录中的启动入口，保留原来的本机登录配置。

## 文件

| 文件 | 作用 |
| --- | --- |
| `napcat-control.ps1` / `.vbs` | 启动窗口与隐藏窗口入口 |
| `napcat-status.ps1` | 真实连接检查，避免用端口监听冒充在线 |
| `launcher-settings.ps1` | 从本机配置读取路径与任务名 |
| `napcat-boot.ps1` / `napcat-boot-hidden.vbs` | 可配置路径的启动入口，凭据从本机文件读取 |
