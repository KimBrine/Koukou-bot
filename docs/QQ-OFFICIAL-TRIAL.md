# QQ 官方接入试验

本分支从 `py` 的 `0fca207` 派生，保留 Python 机器人和 Koukou Studio 控制台。腾讯官方 QQ SDK/扫码连接器负责连接，Python 继续管理人格、模型、记忆、插件及回复规则。没有把原版 DSH 插件的 Agent 再运行一遍。

上游 `@tencent-connect/dsh-qqbot@0.5.3` 的网关将 QQ 消息直接交给 DSH Agent，未提供外部 Python 后端配置。本试验复用它所用的 `@tencent-connect/qqbot-nodejs@1.0.5` 与 `@tencent-connect/qqbot-connector@1.2.0`，增加只监听本机、经鉴权的连接桥。它不是把原版插件直接装进 Python，也不接管原 NapCat/LLBot 实例。

## 使用独立身份

扫码得到的是 QQ 开放平台机器人的 AppID/AppSecret。群、群成员和私聊使用应用范围的 OpenID，不是原群号或个人 QQ 号。

每个应用使用独立配置、数据目录和桥接状态。控制台显示原始 OpenID及内部编号；内部编号仅兼容原业务的数据格式，不是 QQ 号。群成员身份与私聊身份分开授权，不自动继承旧白名单、管理员、聊天记忆或群权限。首次绑定后应用身份固定，换应用必须新建实例。人格文字可通过控制台单独导入。

## 当前能力

| 功能 | 试验状态 |
|---|---|
| 既有控制台、人格编辑、模型配置、记忆浏览、本地表情包管理 | 保留，使用独立数据 |
| 群聊被 @、私聊的文字回复 | 已做本机完整链路验证；真实账号仍需扫码验收 |
| 图片/表情包 | 单张 PNG/JPEG/GIF/WebP，最多4MiB；先文字后图片 |
| 解题模式 `/Q` | 保留；按官方通道可用的回复次数发送，额度不足时不先发一截回答 |
| 机器人自有消息撤回 | 仅允许桥已确认发送、且应用/会话/消息ID匹配的消息 |
| 群管理、帮群员撤回、拍一拍、音乐卡、合并转发、文件 | 首期尚未适配；界面提示且后端拒绝 |
| 自动 +1、主动搭话、早晚安、定时推送、完整群总结 | 首期关闭；不能把有限事件当作完整群历史 |
| 原群/好友名单 | 只显示本实例实际观察到的会话，不冒充完整名单 |
| 旧记忆/指令批量导入、旧备份恢复 | 首期拒绝，避免身份错配 |

本桥采用保守的被动回复窗口：群聊5分钟、私聊30分钟，每条消息最多4次发送尝试。没有有效被动目标时不降级为主动发送。模型生成期间来了新消息，回复目标仍绑定原问题。群消息是否完整到达取决于应用授权；识别某个事件名不等于已获得全量消息。

## 创建试验配置

在本分支安装 Python 包与桥接依赖：

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -e ".[images]"
npm ci --ignore-scripts --prefix integrations/qq-official-bridge
.\.venv\Scripts\python -m koukou init-qq-official --destination "D:\Koukou-trial"
```

目标必须尚未存在、父目录已存在。命令创建独立 `profile.env`、空数据/日志目录和默认人格，随机产生本机桥令牌；不会读取旧实例配置、导入凭据、连接 QQ 或启动模型。输出不含令牌。先保留默认端口8791/8792，若被占用，应同时调整对应启动参数及桥地址。

在一个终端启动桥：

```powershell
node integrations/qq-official-bridge/cli.mjs --env-file "D:\Koukou-trial\profile.env" --credentials-file "D:\Koukou-trial\bridge\credentials.json" --state-dir "D:\Koukou-trial\bridge\state" --port 8792 --enable-qq
```

`--enable-qq` 允许使用已有凭据连接，或接受控制台的扫码请求；没有凭据时不会自动开始扫码。省略该参数则仅启动离线桥，绑定和 QQ 连接均禁用。

在第二个终端启动 Python 控制台：

```powershell
.\.venv\Scripts\python -m koukou --root "D:\Koukou-trial" --env-file "D:\Koukou-trial\profile.env" run --enable-native --data-dir "D:\Koukou-trial\data" --log-dir "D:\Koukou-trial\logs" --profile qq-official-trial --port 8791
```

打开 `http://127.0.0.1:8791/`，在工作台或 QQ 官方连接页点击“开始扫码绑定”，使用手机 QQ 完成绑定。AppSecret只保存到私有桥凭据文件，不返回网页。然后在控制台配置模型、人格；收到首条官方事件后再选择对应 OpenID授权私聊或管理员。私聊默认不在白名单，不能把原 QQ 号填作新身份。

二维码每两分钟主动换新，官方连接器通知过期时也会重新获取；获取新码超过30秒会显示错误并允许重试。手机提示失效时，回到控制台点击“重新生成二维码”，返回手机旧页面后，用手机 QQ 的“扫一扫”重扫新码。刷新连接状态只更新显示，不创建新扫码任务。二维码识别困难时可打开同一个腾讯官方绑定页；不自定义尚未注册的接入来源名称。

两个入口均以前台方式运行，各自在原终端按 Ctrl+C 停止。也可用 `stop-native --execute` 优雅停止 Python；这不停止独立桥进程。旧 Node 启停器、计划任务和正式环境不作修改。

Windows 独立安装可使用 `integrations/qq-official-bridge/windows/` 的启动模板：安装根目录下放置完整源码 `app/`、Python虚拟环境 `.venv/`、独立配置 `profile/`、含当前提交号 `commit` 的 `installation.json`，并把 `launcher.py` 和 `official-host.mjs` 复制到安装根目录。运行 `python launcher.py start` / `stop`，或用 `pythonw launcher.py start --open` 创建桌面入口。启动器串行执行启停，重复启动复用原实例；仅在确认旧桥进程已退出时归档其残留锁，仍活跃或状态不明的锁不自动处理，凭据与投递记录保持原样。此模板不设置自启动或看门狗。

## 数据与验证

`profile.env`、`data/`、`bridge/` 中包含令牌、应用凭据、身份映射和投递记录，属于私有运行资料。请保存整个试验实例目录；不能只备份聊天记忆后另建一份身份映射。未知发送回执不重试，自有撤回不确定时也不重放。

测试使用假 SDK/扫码连接器、临时数据和本机 WebSocket，覆盖两种语言的完整链路，不向真实群聊发消息。离线成功不等于已完成扫码、平台权限或真实送达验收。安装后的纯 Python/OneBot模式仍不需要 Node；官方连接方式额外需要本机 Node 桥。

上游依据：[官方插件网关](https://github.com/tencent-connect/dsh-qqbot/blob/d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9/src/gateway/bootstrap.ts)、[官方插件绑定服务](https://github.com/tencent-connect/dsh-qqbot/blob/d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9/src/setup/binding-service.ts)。本项目不把依赖包源码复制或重新标记为自己的许可证。
