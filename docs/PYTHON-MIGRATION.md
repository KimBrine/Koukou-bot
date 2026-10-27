# Python 后端迁移

## 当前边界

完整后端和插件系统在 `py` 分支迁移，网页保留 HTML/CSS/JavaScript。基线为 main 的 `d336b09`。旧后端在 `src/` 留作对照；Python 运行时不启动 Node 执行业务。

**当前处于整体验证，尚未自动接管生产。** 基线模块和控制台路由已有对应实现，仍须区分离线验收、真实服务联调和生产切换。`migration --require-complete` 返回非零，裸 `run` 拒绝连接；受控运行必须显式启用并提供实例路径。没有合并 main 或调整正式计划任务；仅在另行授权的备份窗口短暂停止并恢复了原JS实例。

## 已实现与验证范围

| 范围 | 原生实现和验证 |
| --- | --- |
| 消息与模型 | OneBot WebSocket、回执、账号变化、完整上下文、引用与嵌套转发、单轮 `/Q`、联网搜索、独立识图；本地 HTTP/WS 贯通测试 |
| 回复 | 不因后来消息取消已受理问答；长文本按 QQ 消息大小分段但保留全文；整段只计一次额度、一次自动配图概率；直接提问额度独立 |
| 群管理 | 目标与原话证据、实际身份、机器人权限、一次补充、时长与全员禁言边界；低于一分钟不执行；拍一拍核验执行者 |
| 人格与记忆 | 人格分区、手改长期记忆暂停整理、原文检索、清理边界、事务与恢复；旧 JS 写入器生成数据的兼容测试 |
| 表情包 | 人格库、两轮学习、60 张容量锁、模糊加权抽取、整段概率、明确索图、黑名单预览、手动上传与 AI 补全、联网选图 |
| 群总结 | 完整历史窗口、稳定性证明、全量统计、证据与话题质量、引用/转发/图片参考、进度、定时及查漏；流持续有数据时不设整份总时限 |
| 定时互动 | 人格绑定的静态早晚安、自定义定时指令、每日链式任务；静谧与账号边界、发送去重 |
| 指令与附件 | 统一指令中心、原生插件 SDK、两平台点歌、文件/链接、普通 zip/7z/rar 打包、1GB 文件及自动撤回回执规则 |
| 控制台 | 原前端资源、配置、会话、人格包、记忆、图库、指标、错误、更新、登录管理；按实际前端 payload 做 HTTP 工作流测试 |
| 生命周期与分发 | 预览/原生服务共用实例锁、并发/取消清理、启动失败、重启、信号与崩溃恢复；本机协议验证两代后台任务和连接释放；sdist→wheel→无 Node 安装验证 |

DeepSeek 请求及重试始终使用 max。HTTP 成功状态中的模型内容检查失败仍作为失败处理；截断、流中断或工具协议不当作可发送正文。发送和管理动作在提交前记录意图，未知回执不自动重发；这优先避免重复执行，不等于跨进程保证恰好执行一次。

群总结输出不设本地 token 预算；单次长时间无数据允许断线恢复。服务商内容检查拒绝不反复重发同一原文，也不虚构总结；可用统计版明确标识。测试不会把模型输出或启动成功当作真实 QQ 功能验收。

## 安装与预览

需要 Python 3.11 或更新版本，使用独立虚拟环境：

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -e ".[images]"
.\.venv\Scripts\python -m koukou migration
.\.venv\Scripts\python -m koukou preview --port 8790
```

源码安装默认在当前项目的 `data-python/preview.env`、`data-python` 和 `logs-python` 运行预览，不读取根 `.env` 的生产设置。预览仅监听 `127.0.0.1`，没有 QQ、模型或后台发送连接。不要通过 `--env-file` 把正式实例交给开发预览。

wheel 随附前端、迁移清单及公开示例插件，默认写入稳定的用户实例目录，不向 site-packages 或任意当前目录写入。可用 `--root` 或绝对路径 `KOUKOU_INSTANCE_DIR` 明确选择开发实例。详见 [Python 分发验证](PYTHON-DISTRIBUTION.md)。

`images` 安装 Pillow 以进行实际相似图检测；未安装会明确禁用相似检测，SHA-256 去重仍可用。旧 System.Drawing 与新 Pillow 指纹版本不混算。

## 插件

```powershell
.\.venv\Scripts\python -m koukou plugin install-bundled
.\.venv\Scripts\python -m koukou plugin new hello --description "简单问候"
.\.venv\Scripts\python -m koukou plugin run hello 群友
```

随附插件安装不覆盖已有同名文件。新插件位于 `plugins/python`，使用 `from koukou.plugin import plugin, Result`，支持同步或异步函数及结构化文字、图片、文件。旧 stdout、`@@CARD@@` 和 `@@FILE@@` 继续兼容。SDK 插件需要安装此 Python 包；插件以机器人进程权限执行，只运行可信代码。

聊天入口直接使用 `/calc 1+2`、`/jm 帮助` 或控制台设置的调用名，与内置指令并列；旧 `/py` 仅兼容。群聊仍须外层 @ 或可靠引用机器人，私聊遵守白名单。源码声明的管理员限制不能通过控制台解除；名称冲突会拒绝注册。

## 数据检查与恢复演练

```powershell
.\.venv\Scripts\python -m koukou audit-data --data-dir "D:\bot-instance\data"
.\.venv\Scripts\python -m koukou snapshot-data --data-dir "D:\offline-instance\data" --destination "D:\migration-snapshot"
.\.venv\Scripts\python -m koukou verify-snapshot --snapshot "D:\migration-snapshot"
.\.venv\Scripts\python -m koukou rehearse-restore --snapshot "D:\migration-snapshot" --destination "D:\migration-rehearsal"
```

审计只读数据，输出结构检查结果、计数和集合指纹，不回显私有人格、正文、群号或凭据。它不构造运行服务。`compatible` 不是可切换证明；资源范围超出或文件变化会报检查不完整。见 [只读审计](PYTHON-DATA-AUDIT.md)。

快照默认覆盖明确目录内全部文件；排除项必须显式声明并记入私有清单。创建和派生只允许全新目录，核对文件集合与 SHA-256，禁止写回源目录。配置仅归档为 `source.env.backup`，不会激活；复制的运行锁不被解除。失败保留 incomplete，不删除源数据。见 [快照与恢复演练](PYTHON-SNAPSHOT-REHEARSAL.md)。

正式切换仍需停止源实例写入后的完整快照及回滚验证；对运行目录的只读检查不能代替停写快照。控制台删除会话另有原始群归档备份和中断恢复；恢复旧记忆时保留较新的不可逆发送记录。

## 回归与剩余验收

```powershell
.\.venv\Scripts\python -X utf8 -m unittest discover -s python/tests -v
$env:KOUKOU_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
node scripts/test-python-parity.mjs
.\.venv\Scripts\python -X utf8 scripts/check-python-distribution.py
npm test
```

原 JS 测试及跨语言对照只作为行为参照，原生服务测试使用临时数据与本机模拟 HTTP/WS。分发检查从 sdist 干净构建 wheel，在空工作目录、无 Node PATH 的隔离进程验证资源、SDK 和控制台。CI 覆盖 Windows/Linux、Python 3.11/3.14。

已额外核对现有 NapCat 的只读状态、登录账号、成员与历史消息结构，并用通用测试题验证聊天、总结 SSE 和表情包读图模型请求。随后在用户明确授权的群完成实际文字、QQ表情、图片、小文件及拍一拍请求，五条测试消息均收到发送和撤回回执；拍一拍经当前聊天模型识别，实际动作后生成回应。未执行禁言。

运行中全量快照检测到近期/长期记忆变化时中止，保留 incomplete。随后获得明确停写许可，核对目标JS进程与原恢复任务，保存记忆后短暂停止目标实例，完成完整数据和配置快照及逐文件SHA-256校验，并恢复原JS实例、核对控制台与QQ在线。原有备份在常规备份轮换前另行完整归档。

该停写快照的全部JSON/JSONL语法及结构审计通过，可派生到新目录恢复并由Python预览加载，关键控制台读接口通过；原始快照保持不变，未把恢复副本覆盖回原数据。快照工具本身仍只报告双扫描一致性，实际停写身份与恢复在线证明保存在私有操作记录中，两者不能混淆。正式入口切换仍未执行，LLBot与群管理权限的实机覆盖也须单独核对。

另从快照派生独立副本，验证完整非预览Runtime可构造近期/长期记忆、人格、表情包、插件和各模型用途；协议与模型注入离线替身，没有网络、子进程、外部写入或后台发送。正常关闭释放会话和实例锁，并可再次获取；这证明真实数据兼容加载，不等同于已在生产持续运行。

新增的[显式运行入口](PYTHON-NATIVE-RUN.md)要求绝对实例路径并遵守 ADMIN_PORT/ADMIN_ENABLED；[独立启停入口](PYTHON-NATIVE-CONTROL.md)默认只读，实际停止通过实例代际校验及本机鉴权优雅收尾，并核对进程退出与旧锁释放。回环子进程覆盖错实例、过期锁、预览拒绝、Windows退出探测及重启后的旧请求失效；旧 Node 计划任务和启停脚本保持原状。不得把本轮结果解释为已经覆盖 main 或批准切换；真实群测试继续限定明确授权的范围。
