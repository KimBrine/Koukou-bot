# SnowLuma兼容接入与回复行为

SnowLuma是第三方QQ客户端互操作运行时，提供OneBot v11。Koukou继续使用自己的Python业务、控制台、模型、人格、记忆和插件；不导入第二套AI机器人逻辑。兼容依据为SnowLuma v2.2.1及其动作目录，实际账号的群管理、文件和历史读取仍需要实机验收，不能仅凭接口同名声称全部可用。

本项目不包含SnowLuma源码或二进制，不将其重新标记为GPL。请从[上游发行页](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.2.1)自行获取并阅读上游许可、EULA与隐私政策。首次同意条款、设置密码、登录QQ和选择接入哪个QQ进程由用户完成；不要通过环境变量替用户同意条款。

## 独立实例

原QQ号/群号可继续用于OneBot数据，但不能把官方机器人的OpenID当成原QQ号。使用原JS停写快照派生独立实例，保留原始快照和回退资料。不要给官方OpenID实例直接改传输方式，也不要同时运行两份连接同一QQ账号的回复后端。

SnowLuma `config/runtime.json` 建议先使用：

```json
{"webuiHost":"127.0.0.1","webuiPort":5099,"hookAutoLoad":false}
```

在SnowLuma网络配置中启用本机Universal WebSocket，例如端口3012，设置独立连接令牌；HTTP和反向连接按需开启。不要暴露到公网，不要复用NapCat进程或让旧看门狗自动启动其他后端。Koukou独立实例配置：

```dotenv
ONEBOT_IMPLEMENTATION=snowluma
ONEBOT_WS_URL=ws://127.0.0.1:3012/
ONEBOT_ACCESS_TOKEN=<与SnowLuma配置一致的私有令牌>
```

在“QQ登录”页可打开本机SnowLuma，并编辑OneBot连接字段；连接字段保存后重启该独立实例。SnowLuma模式不调用NapCat/LLBot登录管理接口。首次接入后应核对账号与版本，再逐项验收真实发送，不自动向群里发送测试消息。

## 手动开关

“回复行为 → 输入状态与发送节奏”提供三个独立开关，全部默认关闭、可随时恢复：

1. **私聊显示正在输入**：仅明确选择SnowLuma的OneBot实例可启用。`set_input_status` 使用 `event_type=1` 开始、`0` 清除；只处理已经允许回复的私聊，不用于群聊。取消、生成结束或出错后清理；连接/账号变化后不操作新账号。状态接口失败不阻塞正常回复，同一连接不反复探测失败接口。不循环请求输入状态，不逐字发送消息。
2. **按回复长度调整等待**：按字或文字单元计算额外等待。中文按字，拉丁文字单元按单词；与既有随机等待取较大值，默认8单元/秒、最多8秒。正文完整发送，不截断、不额外调用AI，不改变模型或群总结的超时与token策略。
3. **固定语库减少近期重复**：拍一拍、人格早晚安语库和随机自定义回复从已有候选中轮换。默认避开最近3条，按账号、会话、人格及规则隔离，只在确认发送后记入历史。候选用尽时先复用最久未发的一段；只有一段则仍使用原句，不凭空改写，不接入AI。

输入状态接口不等于真的把字符逐个写入QQ客户端输入框。目前没有验证“输入框状态/内容决定封号计分”的说法，上述设置和更换客户端都不能保证绕过平台检测或避免封号。

依据：[SnowLuma接入与配置](https://snowluma.github.io/en/docs/guide/configuration)、[输入状态动作](https://snowluma.github.io/en/docs/api/extended/set_input_status)。
