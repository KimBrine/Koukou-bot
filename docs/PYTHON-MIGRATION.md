# Python 后端迁移

## 范围与状态

目标：完整迁移机器人后端与插件系统，保留现有网页 HTML/CSS/JavaScript。迁移从 main 的 `d336b09` 开始，在 `py` 分支和独立工作目录进行，不切换正式实例，不自动合并回 main。

**当前为首批原生实现，尚未实现完整功能等价，也未达到生产切换标准。** 测试和 GitHub 检查通过，只证明已实现部分满足现有测试，不能解释为所有功能已经迁移。

旧后端保留在 `src/` 作为行为参照；Python 代码在 `python/koukou/`，运行时不借助 Node 执行旧业务逻辑。保留旧代码不代表对应功能已由 Python 承接。

## 已有首批实现

| Python 模块 | 范围 | 验证/边界 |
| --- | --- | --- |
| `config.py`、`state.py` | UTF-8配置、原子写入、独立目录、实例锁 | 损坏文件拒绝覆盖；默认不读写正式实例 |
| `onebot.py` | asyncio WebSocket、echo回执、断线失效、状态核验 | 本地真实WebSocket测试；发送超时不自动重发；未连接真实QQ |
| `models.py` | OpenAI兼容HTTP、DeepSeek max、重试、识图请求格式 | 本地HTTP测试；401不重试、截断不发送；未调用真实模型 |
| `messages.py`、`policy.py` | CQ解析、时效、寂静时段、普通回复决策与复读指纹 | 192组回复决策及10组指纹与JS纯函数对照；不代表全部互动等价 |
| `memory.py` | 近期记忆、长期记忆整理、手动编辑取消迟到回写、原文留存 | 并发、手动修改与清空边界测试；完整人格/档案格式迁移仍待验证 |
| `plugin.py`、`plugins.py` | 原生SDK、模板生成、插件列表/导入/停用/执行 | UTF-8、语法检查、路径校验、超时/输出限制、结构化结果解码 |
| `bot.py` | 普通聊天、单轮/Q、基础/py、寂静存档、已确认发送后记忆 | 使用模拟协议与模型验证；没有正式接线或生产切换 |
| `admin.py` | 复用网页静态资源，基础配置/记忆/插件API | Host、Origin、令牌与Content-Type检查；未迁移API返回501 |

插件子进程不是安全沙箱，仅允许管理员安装可信代码。SDK能返回文字和结构化附件结果；附件的QQ发送、定时撤回和回执完整协议仍在待迁移范围，不能宣称已替代正式插件功能。

## 待迁移与验收

完整基线清单在 `python/migration-contract.json`：89个JavaScript模块文件（包含保留的前端脚本）、28个GET接口、79个动作接口。`python -m koukou migration` 列出尚未映射的模块和未实现的接口；`--require-complete` 当前应返回非零。

后续必须完成：

1. 指令中心权限与自定义规则完整移植；群管理/撤回/拍一拍必须保持实际QQ身份核验、一次补充、请求失效和寂静时段语义。
2. 人格选择、分区、导入导出、备份恢复、私有档案与长期记忆检索保持完整隔离；需给出只读检查、备份与回滚工具，禁止直接拿正式数据试迁移。
3. 群总结的历史读取、完整性、引用/转发读取、话题质量、重试、进度、发送队列与去重全部移植。
4. 表情包人格库、学习、两轮复核、加权选图、容量、上传、黑名单、联网找图与概率语义全部移植。
5. 点歌、联网文字搜索、图片缓存、装饰/分行、盯人、早晚安和自定义定时任务完整移植。
6. 文件打包/分卷、插件附件与聊天卡片发送、超时不重发、自动撤回完整移植。
7. 控制台剩余API、QQ登录、更新、诊断、指标、备份和Windows启动/停止/重启方式完整移植。
8. 对上面每项建立行为对照和故障恢复测试；跨Windows/Linux、Python 3.11/3.14验证；正式QQ实测另行得到授权。

完成这些之后，才能移除预览限制、开放Python正式运行入口，并讨论是否合并/切换main。不得为了让验收通过，把缺少的接口改成返回空成功。

## 安装与预览

需要Python 3.11以上，单独虚拟环境安装：

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -e .
.\.venv\Scripts\python -m koukou migration
.\.venv\Scripts\python -m koukou preview --port 8790
```

控制台预览只绑定127.0.0.1，顶部显示迁移提示。默认使用当前分支目录的`data-python`，不会接管main的8788端口或QQ连接。预览支持的写操作仅适用于开发数据，不能保证对全部旧数据格式的兼容；不要传入正式数据目录。

## 新建插件

```powershell
.\.venv\Scripts\python -m koukou plugin new hello --description "简单问候"
.\.venv\Scripts\python -m koukou plugin run hello 群友
```

生成`plugins/python/hello.py`，保持顶部元数据，编辑函数即可：

```python
from koukou.plugin import plugin

@plugin.command
def handle(args: list[str]) -> str:
    return "你好，" + (" ".join(args) or "大家")

if __name__ == "__main__":
    plugin.run()
```

可使用`async def`，需要结构化输出时返回`Result(text=..., images=[...], files=[...])`。运行器保持兼容独立脚本的stdout、`@@CARD@@`和`@@FILE@@`解码；这只证明结果能被解析，不等于附件已在QQ里发送。新SDK依赖此Python包，不应把SDK插件直接放进尚未安装该包的main实例。

## 离线验证

```powershell
.\.venv\Scripts\python -X utf8 -m unittest discover -s python/tests -v
node scripts/test-python-parity.mjs
```

前者使用临时文件、本地HTTP和WebSocket模拟服务；后者仅调用JS/Python纯函数做对照。两者不发送真实QQ消息、不调用付费模型。保留原有Node离线回归，避免迁移分支无意破坏旧参照。
