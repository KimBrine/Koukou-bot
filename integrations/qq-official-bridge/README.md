# Koukou 官方 QQ 通道桥（实验）

这层桥复用 `@tencent-connect/dsh-qqbot` 使用的腾讯官方 SDK 和扫码连接器，把消息交给现有 Python 机器人及控制台。它不运行 DSH Agent，也不是原版 `dsh-qqbot` 插件原样装入 Python。

固定依赖：`@tencent-connect/qqbot-nodejs@1.0.5`、`@tencent-connect/qqbot-connector@1.2.0`、`ws@8.21.0`、`qrcode@1.5.4`；Node.js >=20.3。安装时不执行包脚本：

```powershell
cd D:\Koukou\integrations\qq-official-bridge
npm ci --ignore-scripts
$env:KOUKOU_QQ_BRIDGE_TOKEN = (node --input-type=module -e "import {randomBytes} from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64url'))")
node cli.mjs --credentials-file D:\Koukou-private\qq-credentials.json --state-dir D:\Koukou-private\bridge-data --port 8792
```

请先创建 `D:\Koukou-private`。`bridge-data` 必须为新目录或本桥已标记的目录，不能使用 Python/Node 机器人的 data 目录。凭据文件与状态路径必须明确为绝对路径，不覆盖未知凭据格式。令牌须至少32个无空白字符，Python 连接端使用同一令牌；令牌、凭据、登录及发送状态均属于私有文件，不加入 Git。

上述命令只启动 `127.0.0.1` 上的本机 WebSocket 服务，不连接 QQ、不生成二维码。明确添加 `--enable-qq` 后，已有凭据才会连接 QQ；没有凭据时仍等待控制台主动发起扫码。扫码返回的是 QQ 开放平台机器人 AppID/AppSecret，不是原个人 QQ 登录态。

服务只接受 `Authorization: Bearer <令牌>`，不接受 URL 中的令牌。浏览器外部 Origin、非本机 Host 和其他路径会被拒绝；Python 应经后端连接，不能把桥接令牌交给网页。SDK 和扫码流程的错误不会原样打印凭据或用户内容。

## 当前支持

- 由官方 SDK 接收的私聊/群聊事件，保留 `rawEventType`、OpenID、附件、引用索引及提及字段。能收到 `GROUP_MESSAGE_CREATE` 不等于该 App 已获完整群消息权限。
- 纯文字回复、单张 PNG/JPEG/GIF/WebP 图片（<=4MiB）。一次动作只发一种内容；混合、超限或非法图片在发送前整体拒绝，不读取任意本地路径或 URL。
- 仅撤回本桥确认发送、且应用/会话/消息ID全部相符的自有消息。
- 控制台扫码开始/取消、绑定状态和在线状态。Secret只保存在私有凭据文件，公开状态不返回 Secret 或绑定用户 OpenID。

首期不提供主动推送、文件、禁言、全员禁言、拍一拍、音乐卡片、合并转发、成员/角色列表或服务端历史。群消息摘要只能使用确实收到并归档的记录，不能把本地缓存声称为完整历史。

本桥采取保守的被动回复窗口：群聊5分钟、私聊30分钟，每条入站消息最多4次发送尝试。必须使用本桥已接收、且目标一致的 `msgId`；超时/额度耗尽后直接拒绝，不降级主动推送。发送使用 `sendText`，不擅自改成需要额外权限的 Markdown。

## 本机协议

协议名称为 `koukou-qq-official-v1`，端点 `ws://127.0.0.1:8792/bridge`（也接受 `/`、`/ws`）。

请求：`{action, params, echo}`；响应：`{echo,status:'ok'|'failed',retcode:0|1,data?,message?,code?,outcomeUnknown?}`。

- `qq.status`：协议/AppID、online、binding.phase、可选二维码 PNG data URL、SDK版本和能力表。
- `qq.binding.start` / `qq.binding.cancel`：只在明确启用QQ时启动扫码；取消后的旧回调不会替换凭据。
- `qq.send`：`{scope:'c2c'|'group',targetId,msgId,segments:[{type:'text',text}]}` 或单张 `{type:'image',base64,mime}`。
- `qq.recall`：`{scope,targetId,messageId}`。

新连接和状态变化推送 `{type:'qq-status',data:status}`；入站消息推送 `{type:'qq-message',appId,data:normalizedSdkMessage}`。AppID未绑定时为空，不伪造在线。

变更请求的 `echo` 必须唯一。发送前先持久化意图，收到确切消息ID并持久化自有消息记录后才返回成功；相同 echo 不重复调用 SDK。未知结果不自动重试，未确定的撤回不再次执行。若状态文件不可写，停止接受后续发送。状态目录有独占实例锁，退出用 Ctrl+C；异常退出残留锁时，须先确认旧进程已退出并保留状态文件，不能直接启动第二份实例。

## 离线测试

```powershell
npm test
```

测试使用临时目录、假 SDK/扫码连接器和本机 WebSocket，不绑定真实 QQ，不发真实消息。它验证接口与失败行为，不代表完成真实官方机器人接入验收。

上游：[官方插件](https://github.com/tencent-connect/dsh-qqbot)、[官方 SDK](https://github.com/tencent-connect/qqbot-nodejs)。
