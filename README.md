# Koukou. 聊天机器人 · Koukou Studio

本仓库汇总 QQ 机器人、Koukou Studio 控制台、自定义人格、调试工具和 NapCat 启动中心的源码。项目沿用现有功能与本机配置方式。

- [从这份项目开始练习 Git 和 GitHub](docs/GIT-GITHUB.md)
- [Windows 部署与本机目录说明](docs/WINDOWS-SETUP.md)
- [NapCat 启动中心源码](integrations/napcat/README.md)
- `npm test`：运行本地模拟检查；`npm run check:repo`：检查将纳入 Git 的文件。

仓库保留配置示例；API Key、QQ 登录态、聊天记录、记忆、日志与图片缓存保存在本地，由 `.gitignore` 排除。提交钩子会再检查暂存区，避免把本机凭据写入提交。

```text
src/                 机器人与网页控制台
scripts/             测试、调试与维护工具
integrations/napcat/  NapCat 自定义启动中心
personas/            人格提示词
docs/                部署说明
.env.example         空密钥配置模板
```

把 DeepSeek API 接入 QQ 的非官方聊天机器人：像真人一样在 QQ 里自助聊天。**零依赖**，只需 Node.js 22+。

```
你的 QQ 好友/群
     ↕  QQ 协议
NapCatQQ（OneBot 11 实现）
     ↕  WebSocket（ws://127.0.0.1:3001，正向连接，收发同一条）
deepseek-qq-bot（本目录，Node.js）
     ↕  HTTPS
DeepSeek API（https://api.deepseek.com）
```

## ⚠️ 风险声明（务必先读）

- 本项目通过 **非官方协议**（NapCatQQ 等）接入 QQ，违反《QQ 软件许可及服务协议》，**账号存在被限制登录甚至封禁的风险**。
- **强烈建议使用 QQ 小号挂机器人**，不要用有重要联系人的主号。
- 请勿用于发广告、批量骚扰等行为，低调使用。由此产生的一切后果由使用者自行承担。

## 功能特性

| 特性 | 说明 |
| --- | --- |
| 回复策略 | 私聊全回 · 群内被 @ 必回 · 白名单群按概率主动搭话（默认 10%） |
| 像真人 | 口语化人设、回复长度跟着对方走、不暴露自己是 AI、有观点有情绪 |
| 长度自适应 | 回复长度跟着对方消息长度走（你说得短我也短），以一行 为主、偶尔 2~3 行，分行时逐行分条发送 |
| 识图/表情包 | 按 `VISION_PROVIDER` 选择视觉模型；当前运行实例使用 DeepSeek `deepseek-flash` 读图，再由对话模型生成回复 |
| 每日群聊总结 | 每天 23:00 自动总结白名单群当天消息并发送（`SUMMARY_*` 配置）；群里 @机器人或私聊发「今日总结」可手动触发 |
| 长期记忆 | 每个会话（私聊按人、群聊按群）保留最近 N 条对话，重启不丢 |
| 高可用 | 断线自动重连、请求失败指数退避重试、并发限流、总结失败自动回退主模型 |
| 长回复 | 自动按段落切分成多条消息发送 |
| 自动 +1 | 白名单群连续两条相同纯文字群友消息后原生跟一次，同一连续段只跟一次，自己的消息不计数；不调用模型 |
| 零依赖 | 只用 Node.js 内置的 fetch / WebSocket，无需 npm install |

---

## 自动 +1

在控制台「回复行为 → 自动 +1」开启/关闭，即时生效。当前账号已启用。

- 只在白名单群运行，独立于普通聊天开关、静音、安静时段与主动搭话概率。
- 仅支持纯文字消息。保留原文字的换行与空白，使用 NapCat `forward_group_single_msg` 原生跟读，不调用 LLM。
- 群友连续两条相同消息后跟一次；相同内容继续刷屏不再跟。不同内容、指令、@ 或引用消息会打断连续段。
- 机器人自己的消息不能起头或计入两条群友消息；自己的跟读也不会再次触发。
- 图片/表情包、QQ 表情、文字与非文字混合消息、指令、@、引用、语音、视频、文件、卡片等不跟读，并打断计数。消息 ID 去重，发送超时不自动重发；已触发的连续段以哈希落盘，重启后不重复跟。
- NapCat 未提供 QQ 界面「+1」提示事件，因此使用连续两条相同消息作为判断条件；不声称能够读取客户端按钮。
- NapCat 对应 WebSocket 服务端需启用 `reportSelfMessage`，这样机器人自己的插话也能正确打断计数。
- 日志搜索 `[自动+1]`；去重状态保存在当前账号数据目录的 `auto-plus-one.json`，只存哈希与消息编号。

## 一、环境要求

- **Node.js ≥ 22**（本机已检测到 v24，直接可用）。检查：`node -v`
- 一个用于挂机器人的 QQ 小号
- （推荐）Docker Desktop，用于跑 NapCatQQ

## 二、部署 NapCatQQ（QQ 接入端）

NapCatQQ 是 OneBot 11 协议的实现，负责登录 QQ 并把消息转成 WebSocket 事件。
项目地址：<https://github.com/NapNeko/NapCatQQ>

### 方案 A：Docker 部署（推荐，无需安装桌面 QQ）

```powershell
docker run -d --name napcat --restart unless-stopped `
  -e ACCOUNT=<你的QQ小号> `
  -p 3001:3001 -p 6099:6099 `
  mlikiowa/napcat-docker:latest
```

扫码登录（首次必须）：

```powershell
docker logs -f napcat
```

在日志里找到二维码，用手机 QQ 扫码确认登录，看到登录成功后再按 `Ctrl+C` 退出日志跟踪。

### 方案 B：Windows 原生部署（需要已安装 NTQQ 桌面版）

1. 到 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 `NapCat.Shell.zip`；
2. 解压后运行启动器（`NapCatWinBoot.bat`），按提示完成登录；
3. 之后与 Docker 方案一样通过 WebUI 配置。

> 注意：新版 NTQQ 对协议机器人限制较多，登录失败时优先用方案 A。

### 配置正向 WebSocket（两种方案都要做）

1. 打开 NapCat 的 WebUI：<http://localhost:6099>（Docker 映射 6099 端口；密码在 `docker logs napcat` 里能看到）；
2. 进入 **网络配置**，新建/启用一条 **WebSocket 服务端**：
   - Host：`0.0.0.0`（Docker 必须；本机原生可填 `127.0.0.1`）
   - 端口：`3001`
   - Access Token：可留空（如果设置了，记住它，下一步要填进 `.env`）
3. 保存后，WebUI 应显示 WebSocket 服务端已启用。

> 其他 OneBot 实现（LLOneBot、Lagrange.Core、OpenShamrock 等）只要支持正向 WebSocket，本程序同样兼容。

## 三、配置并启动机器人

1. 编辑本目录的 `.env` 文件，至少填一项：

   ```
   DEEPSEEK_API_KEY=sk-你的key
   ```

   Key 在 <https://platform.deepseek.com/api_keys> 创建（需要账户里有余额）。
   群聊自动搭话要配置：`WHITELIST_GROUPS=群号1,群号2`。

2. 启动：

   ```powershell
   cd deepseek-qq-bot
   node src/index.js
   ```

   看到 `登录成功：xxx（QQ 123456）` 和 `机器人就绪…开始监听消息` 即成功。

3. 测试：用另一个 QQ 号私聊机器人，或在群里 @ 它。

### 回复策略速查

| 场景 | 行为 | 相关配置 |
| --- | --- | --- |
| 私聊（好友/临时会话） | 全部自动回复 | — |
| 群聊中 @ 机器人 | 必回 | — |
| 白名单群里的普通消息 | 按概率主动搭话 | `WHITELIST_GROUPS`、`PROACTIVE_RATE` |
| 非白名单群里的普通消息 | 忽略 | — |
| 机器人自己发的消息 | 忽略（防自问自答） | — |

### 配置项说明

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空（必填） | DeepSeek 平台创建的 API Key |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 对话模型；`deepseek-reasoner` 推理更强但慢且贵 |
| `VISION_PROVIDER` | `dashscope` | 识图服务商：`deepseek` 或 `dashscope`；当前运行实例设为 `deepseek` |
| `VISION_MODEL` | `deepseek-flash` | `VISION_PROVIDER=deepseek` 时的识图模型 |
| `VISION_CACHE_ENABLED` | `1` | 图片及识图描述缓存；相同 QQ 图片标识优先复用本地文件，图片内容使用 SHA-256 去重，重启后仍有效 |
| `VISION_CACHE_MAX_MB` | `256` | 图片缓存的磁盘大小上限；达到上限后淘汰最久未使用的记录 |
| `VISION_CACHE_MAX_ENTRIES` | `2000` | 图片和识图描述各自的缓存条数上限 |
| `VISION_CACHE_DAYS` | `30` | 缓存最长闲置天数；切换视觉模型或识图提示词后重新识别，日常聊天回复每次独立生成 |
| `DASHSCOPE_API_KEY` | 空 | 使用 DashScope 时的 API Key（[阿里云百炼](https://bailian.console.aliyun.com)） |
| `DASHSCOPE_MODEL` | `qwen-vl-plus` | 仅 `VISION_PROVIDER=dashscope` 时用于识图；当前实例中的 `qwen3.7-flash` 另用于群总结 |
| `ONEBOT_WS_URL` | `ws://127.0.0.1:3001` | NapCat 正向 WebSocket 地址 |
| `ONEBOT_ACCESS_TOKEN` | 空 | 与 NapCat 网络配置里设置的 Token 保持一致 |
| `BOT_NAME` | 小深 | 机器人的名字（写进人设） |
| `WHITELIST_GROUPS` | 空 | 白名单群号，逗号分隔 |
| `PROACTIVE_RATE` | `0.1` | 白名单群主动搭话概率（0~1） |
| `PROACTIVE_RATE_PER_GROUP` | 空 | 按群覆盖主动搭话概率，如 `801944160:0.2`；当前春雨社使用 20% |
| `SUMMARY_ENABLED` | `1` | 每日群聊总结开关 |
| `SUMMARY_TIMES` | `23:00` | 总结运行时间，逗号分隔可多个 |
| `SUMMARY_FALLBACK_ENABLED` | `0` | 启用 23:30 查漏补发；只对确定 23:00 未发过报告且 QQ 实际在线的群补一次 |
| `SUMMARY_GROUPS` | 空 | 总结目标群，留空则用 `WHITELIST_GROUPS` |
| `SUMMARY_MAX_MESSAGES` | `600` | 参与总结的消息条数上限（控制成本） |
| `SUMMARY_PROVIDER` / `SUMMARY_MODEL` | `deepseek` / `deepseek-v4-flash` | 独立的群总结模型配置；当前实例使用 DashScope 的 `qwen3.7-flash`，不承担识图 |
| `SUMMARY_SEND_MODE` | `forward` | `forward`=按空行分段，打包成「聊天记录」合并转发卡片（失败自动退回逐条）；`split`=按空行分段后逐条发送 |
| `SUMMARY_MAX_BLOCKS` | `20` | 每张合并转发卡片最多几条；超出时分成多张卡片 |
| `SUMMARY_USER_ROWS` | `20` | 喂给模型的「每人数据」行数（「群友称号」据此写） |
| `HISTORY_LIMIT` | `20` | 每会话保留的历史条数 |
| `TEMPERATURE` | `1.2` | 采样温度，越高说话越随性 |
| `MAX_TOKENS` | `500` | 单次回复最大 token |
| `TIMEOUT_MS` | `90000` | 单次请求超时（推理模型生成慢，别调太小） |
| `MAX_CONCURRENCY` | `2` | 同时进行的 DeepSeek 请求数上限 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PERSONA` | 空 | 单行人设（优先级最高）；`PERSONA_FILE` 指定人设文件；默认读项目根目录 `persona.txt` |
| `REPLY_LENGTH_MATCH` | `1` | 回复长度自适应：跟着对方消息长度走（`0` = 固定单行） |
| `REPLY_MAX_LINES` | `3` | 最多分几行；分行时每一行作为一条独立消息分开发送 |
| `REPLY_LINE_MAX_CHARS` | `40` | 单行字数上限 |
| `LINE_GAP_MIN_MS` / `LINE_GAP_MAX_MS` | `500` / `1600` | 分条发送之间的补句间隔 |
| `EMOJI_KEEP_RATE` | `0.2` | 颜文字/emoji/QQ 表情的保留概率（其余回复纯文字） |
| `HUMAN_DELAY_MIN_MS` / `HUMAN_DELAY_MAX_MS` | `600` / `2500` | 发送前的随机"打字"延迟 |
| `RATE_LIMIT_PER_HOUR` / `RATE_LIMIT_MIN_GAP_MS` | `25` / `4000` | 每会话每小时发言上限 / 两条回复最小间隔（分条的第 2、3 行不受此限，但仍计入额度） |
| `QUIET_HOURS` | 空 | 安静时段（如 `01:00-07:00`），期间只回 @，不主动搭话也不盯人 |

### 回复长度与多行分条

机器味最重的特征之一是"长度恒定"——不管你说一句还是一段，它都回一样长。这个特性让回复的体量跟着对方走：

- **长度匹配**：本次回复的总字数预算 ≈ 对方这条消息的长度（+ 若干字余量）。对方连发几条你还没回，那几条会按 35% 折算进预算，像真人"一口气把几句都回了"。
- **行数以一行为主**：短消息约 85% 单行；超过 `REPLY_LINE_MAX_CHARS` 后分行概率大幅上升（内容一行装不下，硬凑一行反而长度对不上），最多 `REPLY_MAX_LINES` 行。
- **逐行分条发送**：每一行作为一条独立消息发出，行与行之间有一个较短的补句间隔（`LINE_GAP_*`），模拟"说完一句又补一句"；每行都计入每小时发言额度。
- **兜底裁剪**：模型写超了会在句子/逗号边界裁断；模型把长内容写成一行、而本次允许多行时，会按句子边界自动拆条（不丢内容）。裁剪绝不会砍断 `[表情:xxx]`，避免发出残缺标记。

实测（`node scripts/test-live-length.mjs`，同一份线上提示词、28 个样本）：对方 2 字 → 回复均 5 字；10 字 → 15 字；39 字 → 35 字；98 字 → 77 字（长消息长度比例 0.8~1.0x）。整体单行率 68%，其中短消息 100% 单行、长消息多为 3 条，全程未出现超过 3 行或提示词泄漏。

单元测试：`node scripts/test-reply-shape.mjs`（49 项，覆盖长度匹配、行数分布、拆分/裁剪、表情与标点安全）。

### 群聊日常分析报告

每天 23:00（或群里 @机器人 / 私聊发「群总结」）会自动生成一份分析报告，格式如下：

当前账号已开启「23:30 漏发补发」（控制台 → 群聊报告，修改后需重启）：

- 23:00：先核验 QQ 实际连接，在线才开始定时总结；离线跳过。
- 23:30：按群检查真实发送回执；没有回执时，分页核验当晚 QQ 历史及合并转发内容。只有确认未发过、没有正在进行的任务且 QQ 在线时，才补一次。
- 已发出的报告（包括部分报告）不会再整份重发；发送超时、历史不完整或转发内容无法确认时保守跳过，防止重复。
- 两个时点都没有登录就当晚放弃。之后恢复登录、23:30 后重启或电脑休眠错过检查时点，都不追补。
- 回执与检查时点记录保存在当前账号数据目录的 `summary-delivery-state.json`，重启不会忘记已发状态；日志搜索 `[总结补发]` 或 `[定时总结]`。按北京时间排期。

```
🎯 群聊日常分析报告
📅 2026年09月21日

📊 基础统计
• 消息总数: 745      ← 以下五项全部由代码精确统计
• 参与人数: 13
• 总字符数: 6390
• 表情数量: 46
• 最活跃时段: 09:00-10:00

💬 热门话题
1. 话题标题
   参与者: 甲、乙、丙
   100~200 字把事情讲清楚，提到群友时使用与本条「参与者」栏一致的群昵称
（下一个话题前空一行，通常 3~5 个；真实主题集中时允许 2 个，少量记录按实际写）

🏆 群友称号
• 昵称 - 称号 (MBTI)
  一句话理由，引用真实数据（发言条数 / 平均字数 / 表情占比 / 回复比例）
（每位之间空一行，4~5 位，最多 5 位；人数不足时按实际人数）

💬 群圣经
1. "群里的真实原话" —— 说话的昵称
   一两句点评
（每条之间空一行，3~5 条）
```

报告生成规则：

- **数字由代码算，不由模型数**。模型"数数"必然编，所以 `src/summaryStats.js` 会统计消息数、参与人数、
  总字符数、表情数、最活跃时段，以及每人的发言条数 / 平均字数 / 表情占比 / 回复比例；统计覆盖**确认同步稳定的全天历史与实时捕获消息**
  （不是喂给模型的那 600 条），模型只负责写定性描述。
- **历史回填要确认稳定**。NapCat 断线后返回的首屏可能漏掉中间消息，即使时间已跨过零点也不能证明完整。机器人会以最新消息为游标向前翻页并重复扫描；无法确认稳定时暂缓发送，避免报告写入偏少的条数。
- **选题覆盖完整时间窗口**。程序提供普通文字聊天的时间分布、例行指令与固定猪猪回复的真实计数；模型按持续交流、信息增量、结论和安排选题。固定猪猪模板压缩后送入模型，避免长模板被误当成热点，但原始记录仍参与消息数、发言数等统计。消息预算不足时优先普通文字，并分布到整个窗口。少量例行打卡可以简述或省略；有真实持续讨论时仍可作为主要话题，不为了凑满三项单独扩写打卡。
- **每个条目各占一条消息**。报告标题和日期留在同一条消息，基础统计留在同一条消息；小节标题与该小节第一条放在一起。模型漏写空行时，程序会识别话题编号、称号条目和群圣经条目来补充分段；条目内部的普通换行、多行引文以及字面量 `\n` 保留，不会逐行裁断。
  模型偶尔写出的字面量 `\n` 会显示为真正换行，但不会因此把同一条内容拆成多条消息。
  热门话题正文和参与者栏使用群昵称；模型遗漏的裸 QQ 号、`[QQ号]` / `[@QQ号]` 在发送前按完整记录中的身份对应关系替换，优先沿用该话题「参与者」栏中的昵称（保留括号、表情及跨日别名）。只被提到而未发言的成员可用该群成员名单补查；无法确认身份时不猜名字。网址、已知昵称及群圣经的真实引文保留原文。
  默认用**合并转发**打包成「聊天记录」卡片发出去（`SUMMARY_SEND_MODE=forward`）；若合并转发明确失败会退回逐条发送。开启查漏补发后，发送超时等无法确认结果的情况不会立刻逐条重发，以免重复。块数超过 `SUMMARY_MAX_BLOCKS` 时分成多张卡片，不拆开条目。

自检命令：

```bash
node scripts/test-summary-report.mjs              # 统计、历史回填与分块的单元测试（63 项）
node scripts/test-summary-names.mjs               # 群昵称替换、跨日别名、分段与实际发送路径模拟
node scripts/test-summary-content.mjs             # 例行活动权重、全窗口采样、压缩与选题校验
node scripts/test-summary-schedule.mjs            # 23:00 / 23:30、离线、历史核验、重启与防重复模拟
node scripts/test-summary.mjs <群号> 1 stats      # 只算统计不调模型，核对"每人数据"表
node scripts/test-summary.mjs <群号> 1 dry        # 真实生成并打印报告，不发送
node scripts/test-summary.mjs <群号> 1 ping       # 只发一张 3 条测试卡片，验证合并转发可用
```

## 四、常见问题

**连不上 OneBot（日志刷 `连接失败`）**
NapCat 没在运行，或没启用正向 WebSocket，或端口不是 3001。检查 WebUI 网络配置；Docker 部署检查 `-p 3001:3001` 映射。

**能连上但收不到消息**
确认 NapCat 已扫码登录成功；在 WebUI 里确认群/私聊消息没有被过滤。日志出现 `登录成功` 后才开始监听。

**回复报 `HTTP 401`**
`.env` 里的 API Key 无效或复制多了空格，重新粘贴。

**回复报 `HTTP 402`**
DeepSeek 账户余额不足，去 <https://platform.deepseek.com> 充值。

**回复很慢甚至超时**
`deepseek-reasoner` 模型生成慢，换回 `deepseek-chat`；或调大 `TIMEOUT_MS`。

**机器人掉线了**
本程序会自动重连 OneBot。若 NapCat 本身被 QQ 踢下线（长期挂机可能发生），需重新 `docker logs napcat` 扫码登录。

**记忆保存在哪**
`data/memory.json`，删除该文件即可清空全部记忆。

## 五、开机自启（可选）

> 本机已配置好：任务计划程序中有两个登录自启任务 `NapCatQQ`（登录即启 NapCat）和 `DeepSeekQQBot`（延迟 45 秒静默启动机器人）。机器人日志写入 `logs/bot.log`（10MB 自动轮转）。
> NapCat 登录状态会持久保存，重启后自动快速登录，一般无需再扫码。

**Windows 任务计划程序**（手动配置方法）：
1. Win+R 输入 `taskschd.msc` 打开任务计划程序 → 创建基本任务；
2. 触发器选「计算机启动时」（或「登录时」）；
3. 操作选「启动程序」：程序填 `node`，参数填 `src\index.js`，起始于填本项目绝对路径；
4. 完成。机器重启后自动挂机。

也可以用 pm2：`npm i -g pm2 && pm2 start src/index.js --name qq-bot && pm2 save`。

## 六、看门狗（掉线自动恢复）

`watchdog.ps1` 由计划任务 **KoukouWatchdog 每 3 分钟**以隐藏窗口跑一次，负责：

| 检查项 | 判断 | 动作 |
| --- | --- | --- |
| 机器人进程 | 不存在 | 启动计划任务 `DeepSeekQQBot` |
| 机器人进程 | 多于 1 个 | 只保留最早启动的，其余结束（多实例会抢答、重复回复） |
| NapCat 进程 | 不存在 | 启动计划任务 `NapCatQQ`（独立进程，不依赖任何会话） |
| OneBot 端口 3001 | 连续 2 次不通且 NapCat 在跑 | 判定登录态失效 → 重启 NapCat（快速登录常能自动恢复） |
| OneBot 端口 3001 | 重启后仍不通 | 写桌面《Koukou掉线提醒.txt》+ 弹气泡：**需要你手动扫码** |

一切正常时它完全静默（约每 30 分钟记一行心跳到 `logs/watchdog.log`）。注册命令：

```powershell
$root = 'E:\Deepseek Harness Workplace\deepseek-qq-bot'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $root + '\watchdog-hidden.vbs"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'KoukouWatchdog' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
```

手动排查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1              # 立即检查一次（打印结果表）
powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1 -DryRun      # 只报告，不执行任何动作
powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1 -DryRun -Port 3999   # 演练"端口不通"分支
powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1 -TestAlert   # 预览桌面掉线提醒的样子
```

> ⚠️ 改 `watchdog.ps1` 后必须确保文件是 **UTF-8 带 BOM**：Windows PowerShell 5.1 对无 BOM 的脚本按 ANSI 解码，
> 中文会变成乱码并导致**语法错误**（脚本直接跑不起来）。修复：`[System.IO.File]::WriteAllText($p, (Get-Content -Raw -Encoding UTF8 $p), (New-Object System.Text.UTF8Encoding($true)))`

## 七、机器人控制台（桌面 App）

双击桌面上的 **「Koukou 控制台」** 即可打开：一个没有地址栏的独立窗口（Edge/Chrome 的 app 模式），
看起来就是个桌面应用。它由**机器人进程自己托管**（`http://127.0.0.1:8787`），所以机器人一启动控制台就在，
关掉窗口也不影响机器人；不依赖 Electron，仍然是零依赖。

> 控制台只监听 127.0.0.1，仅本机可访问。想关掉它：`.env` 里设 `ADMIN_ENABLED=0`。

| 页面 | 内容 |
| --- | --- |
| ① 运行总览 | 登录状态（OneBot 连接 / QQ 账号 / NapCat 端口 / 看门狗）、模型、已运行时长、今日各群消息量、快捷操作（重启机器人 / 重启 NapCat / 清除掉线提醒 / 立即检查盯人 / 立即生成报告） |
| ② 会话管理 | 每个群、每个私聊一行，展开即可设置：总开关、被 @ 必回、允许主动搭话、主动搭话概率、装饰符号频率、最多行数/单行字数、安静时段、备注名、**客制化 prompt**；可查看该会话记忆、以机器人身份发消息 |
| ③ 人格 | 多个人格文件的新建/编辑/删除/切换；切换与保存**立刻生效**（下一条消息就用新人格）；下方附只读的"系统附加说明" |
| ④ 拟人化 / 反检测 | 装饰频率、打字延迟、回复长度自适应、行数上限、分条间隔、限流、安静时段、上下文窗口、拍一拍开关 |
| ⑤ 接口与密钥 | 对话模型、视觉模型、温度、token 上限、三个 API Key（默认打码）、日志级别 |
| ⑥ 群聊报告 | 每日报告开关/时间/目标群/发送方式、一键立即生成、历史数据文件 |
| ⑦ 日志 | 机器人日志实时滚动（可过滤关键词）＋看门狗日志 |
| ⑧ 数据 | 会话记忆浏览、长期记忆摘要、日报原始文件 |

**两种生效方式**（界面上每项都有标签）：

- <kbd>即时生效</kbd>：装饰频率、打字延迟、概率、安静时段、行数上限、会话设置、人格切换…… 代码每次用到时才读，改完下一条消息就生效；
- <kbd>需重启</kbd>：限流器、上下文窗口、模型与 Key、日报排期等（它们在启动时构造）——改完点"重启机器人"按钮即可。

### 会话独立设置

存在 `data/chat-settings.json`，只记录"跟全局不一样的项"，所以以后改全局默认值，没单独设过的会话会跟着变。
key 沿用记忆的命名：群聊 `g<群号>`、私聊 `p<QQ号>`。支持的能力：

```jsonc
{
  "g801944160": {
    "enabled": true,            // 总开关：关掉后这个会话完全不回复
    "atReplyEnabled": true,     // 被 @ 必回
    "proactiveEnabled": true,   // 是否允许主动搭话
    "proactiveRate": 0.35,      // 覆盖全局概率（null = 沿用全局）
    "customPrompt": "这个群是同事群，说话正式一点",  // 附加到系统提示词，优先级高于全局人设
    "emojiKeepRate": 0.5,       // 覆盖装饰频率（null = 沿用全局）
    "replyMaxLines": 2,         // 覆盖最多行数
    "lineMaxChars": 30,         // 覆盖单行字数
    "quietHours": "",           // 覆盖安静时段（"" = 这个会话不设安静时段）
    "note": "同事群"            // 备注名，只影响界面显示
  }
}
```

### 命令行 / 脚本调用

控制台就是一个本地 HTTP 服务，任何脚本都能用：

```bash
curl http://127.0.0.1:8787/api/state                      # 运行状态
curl http://127.0.0.1:8787/api/chats                      # 会话列表（含生效值）
curl -X POST http://127.0.0.1:8787/api/action/set-chat \
     -H 'Content-Type: application/json' \
     -d '{"key":"g801944160","patch":{"enabled":false}}'   # 关掉某个群
```

自测脚本：`node scripts/test-admin-api.mjs`（把界面上会调的每个接口真实打一遍，含写入后还原）。

### 视觉验证（改界面时用）

```bash
node scripts/test-admin-api.mjs                            # 接口层
powershell -File scripts/shot-console.ps1 -Url "http://127.0.0.1:8787/#chats"   # 截图
node scripts/cdp.mjs click ".chat .head"                   # 用 CDP 点元素（不受 DPI 影响）
node scripts/cdp.mjs text                                  # 读页面可见文字
```

### 机器人"没反应"的三类原因（按排查顺序）

1. **群里真的没人说话** —— 先跑 `node scripts/probe-all-chats.mjs`，它会列出所有群/好友最后一条消息距今多久。
2. **消息被限流丢掉** —— 以前"两条消息间隔不足 4 秒"会**直接丢弃**这条消息（私聊快问快答时特别容易中）。
   现在改成"最多等 8 秒再发"，只有额度用尽或洪水才放弃，且日志会写明 `[限流] 放弃回复（原因）`。
3. **NapCat 会话半死** —— 最隐蔽的一种：`get_login_info` 仍然有回应（读的是本地缓存），
   但真正发消息会失败：`retcode=1200 ... "errMsg": "网络连接异常!"`。
   这时候 OneBot 端口还是通的、看门狗也不会报警，只有**实际发送**才会暴露。

### NapCat 相关注意事项

- **绝不能让两个 NapCat 同时跑**。QQ 一个账号只允许一个会话，第二个实例做快速登录会把第一个顶下线，
  而第一个还占着 3001 端口 → 表现为"端口通、能读缓存、但发不出消息、Windows 端显示未登录"。
  - 看门狗现在会自动检测重复实例：**保留占用 3001 的那个**，清掉其余整棵进程树。
  - 控制台的"重启 NapCat"按钮以前只 start 不 kill（这就是重复实例的来源），现已改为先杀再起。
- **登录失败只有 NapCat 控制台里看得见**。隐藏窗口会把输出丢掉，所以 `napcat-boot.bat` 现在把
  stdout/stderr 追加到 `E:\NapCatQQ\napcat-console.log`（二维码、登录错误都在里面）。
- 需要重新登录时：双击桌面「启动 NapCatQQ」快捷方式，用手机 QQ 扫码；二维码也会存到
  `E:\NapCatQQ\napcat\cache\qrcode.png`。

### 定时指令（每天定点 @ 某人发固定内容）

当前配置：**每天午夜在春雨社（801944160）@ 幽幽子（3889001246）发送 `/今日猪猪`**，用来触发对方的机器人。时间配置仍为 `00:00`，实际在 **00:00:10** 发送，给 QQ 和对方的跨日更新留出 10 秒缓冲；发送前再次核对时间，避免提前触发。

```bash
DAILY_PING_ENABLED=1
DAILY_PING_TIME=00:00          # HH:mm，24 小时制
DAILY_PING_GROUP=801944160     # 目标群
DAILY_PING_TARGET=3889001246   # 要 @ 的账号
DAILY_PING_TEXT=/今日猪猪       # @ 之后的内容（以「@某人 + 空格 + 内容」发出）
```

- @ 用的是真实 `at` 段，对方会收到 @ 提醒（不是纯文本的 "@名字"）。
- 发送失败按 **60s → 5min → 15min** 重试三次；重试用尽写 ERROR 级日志。
- **失败后先核验再重试**：QQ 有时返回 `retcode=1200 "网络连接异常!"` 但消息其实已经发出去了，
  这时直接重试会在群里刷重复消息。所以失败后会先翻最近 3 分钟的历史，确认没送达才重试。
- **机器人记得自己做过**（两条保险，修的就是"抽完就忘"）：
  1. 发出去的指令会写进会话记忆 —— 主回复路径本来就会 push，但定时指令是独立通道，会漏；
     漏了它就不知道自己说过这句话。
  2. 抽到结果后写入 `data/daily-ping-state.json`，并把「今日已办」注入系统提示词：
     `【今日已办】今天你已经 @幽幽子 抽过「今日猪猪」了，抽到的是【柠檬猪】，也查过「我的猪圈」了。`
     群聊刷几屏就会把这件事挤出记忆窗口，靠这条当天都不会忘，跨重启也有效。
- 手动补发：控制台「运行总览 → 立即发定时指令(@幽幽子)」，或 `node scripts/test-daily-ping.mjs`
  （加 `--dry` 只打印不发送）。
- 补录历史（修上线之前漏记的）：`node scripts/seed-daily-ping.mjs <群号> <猪名> 幽幽子`（先停机器人再跑）。
- 全流程确定性验证：`node scripts/test-daily-ping-flow.mjs`（20 项，不联网、不发消息）。

## 九、故障排查

### 启动就崩、日志里什么都没有？

看 `logs/console.log` —— 隐藏窗口的 stdout/stderr 都落在那里。这是排查"启动阶段崩溃"的唯一线索：
语法错误之类的问题会让进程刚起来就退出，`logs/bot.log`（由机器人自己写）里不会有任何记录，
看门狗也只会看到"进程不存在"而反复拉起，表现为静默的重启循环。

### 改 .vbs / .ps1 / .bat 的硬性要求

| 文件类型 | 要求 | 不加会怎样 |
| --- | --- | --- |
| `.vbs`（bot-start-hidden / 启动控制台） | **只能写 ASCII**（注释也用英文） | wscript 按 ANSI 解码，UTF-8 中文注释会破坏解析，脚本**静默失效**、什么都不启动 |
| `.bat`（bot-start） | **只能写 ASCII + 必须 CRLF 换行** | cmd 同样按 ANSI 解码；中文注释会被当成乱命令，**整个脚本静默不执行**（表现为"重启后机器人根本没起来"） |
| `.ps1`（watchdog / console-app / shot-console） | **必须 UTF-8 带 BOM** | Windows PowerShell 5.1 按 ANSI 解码中文，直接语法错误跑不起来 |

这三条都是实际踩过的：机器人曾因为一处 `.bat` 中文注释而"重启后毫无反应"，日志与看门狗都看不出原因。

补 BOM 的方法：

```powershell
$p = 'E:\Deepseek Harness Workplace\deepseek-qq-bot\watchdog.ps1'
[System.IO.File]::WriteAllText($p, (Get-Content -Raw -Encoding UTF8 $p), (New-Object System.Text.UTF8Encoding($true)))
```

另外：**重定向不能写在 `.vbs` 的 Run 字符串里**（`WScript.Shell.Run` 不会把 `>>` 交给 cmd，进程根本起不来），
所以启动脚本统一走 `bot-start.bat`。

### 重启机器人的正确姿势

```powershell
# 1) 先做语法检查（改完代码务必做，否则会静默启动失败）
cd 'E:\Deepseek Harness Workplace\deepseek-qq-bot'
Get-ChildItem src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
# 2) 再重启
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src[\\/]index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName 'DeepSeekQQBot'
# 3) 确认（注意排除 DSH 自己的 node 进程，否则会把命令行里提到 index.js 的进程也算进来）
@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'index\.js' -and $_.CommandLine -notmatch 'dsh|runner' }).Count
```

### 其他常见问题

- **机器人日志**：控制台输出会同时写入 `logs/bot.log`，开机自启（静默）模式下从这里看运行状态；
- **在线状态**：OneBot 连接、NapCat 报告在线与 QQ 实际连接分开核验。每 30 秒强制从 QQ 获取一次最新资料；只有核验成功才显示绿色在线。请求失败或核验过期时显示待核验，旧心跳不会把失败状态刷回在线。
- **快速验证 DeepSeek Key**：`node scripts/test-deepseek.mjs`，返回 HTTP 200 即 Key 有效；
- **机器人收不到消息但已连上**：检查机器人 QQ 是否在该群/好友列表内，以及 `.env` 的 `WHITELIST_GROUPS` 配置；
- **重启电脑后机器人没上线**：`任务计划程序` 中查看 `NapCatQQ` / `DeepSeekQQBot` 两个任务状态，或手动运行 `E:\NapCatQQ\napcat-boot.bat` 与 `node src\index.js`。

## 免责声明

本项目仅供学习交流。使用非官方协议接入 QQ 存在账号风险，请自行评估并承担后果；请遵守当地法律法规，勿用于骚扰、营销或其他不当用途。
