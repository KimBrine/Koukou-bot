# Python 迁移的隔离快照与回滚演练副本

`koukou.migration_snapshot` 提供三个显式接口：

```python
from koukou.migration_snapshot import create_snapshot, verify_snapshot, derive_rehearsal

created = create_snapshot(
    r"D:\BotMigration\data-source-copy",
    r"D:\BotMigration\snapshot-new",
    exclude=(),
    env_file=r"D:\BotMigration\instance-copy.env",
)
checked = verify_snapshot(r"D:\BotMigration\snapshot-new")
rehearsed = derive_rehearsal(
    r"D:\BotMigration\snapshot-new",
    r"D:\BotMigration\rehearsal-new",
)
```

对应命令行入口为：

```powershell
python -m koukou snapshot-data --data-dir "D:\BotMigration\data-source-copy" --destination "D:\BotMigration\snapshot-new" --source-env "D:\BotMigration\instance-copy.env"
python -m koukou verify-snapshot --snapshot "D:\BotMigration\snapshot-new"
python -m koukou rehearse-restore --snapshot "D:\BotMigration\snapshot-new" --destination "D:\BotMigration\rehearsal-new"
```

命令行如需显式排除，重复提供 `--exclude bot.lock --exclude bot-start.guard`。

示例使用离线源副本。快照与演练目标必须是**从未存在的新目录**，父目录必须已
存在。工具不会清空、覆盖或自动删除任何已有目录，也没有直接还原运行实例的接口。

快照覆盖传入数据目录中的全部文件，包括 daily、personas、config-backups、旧
backups、表情包、不可逆投递记录和未知格式文件，并保留空目录。没有默认排除。
若需排除运行锁或临时子目录，必须显式传入精确相对路径，例如
`exclude=("bot.lock", "bot-start.guard", "temp")`。不接受通配符、绝对路径或 `..`。
这些排除会逐项写进私有 `snapshot.json`，有排除的副本只能按清单声明覆盖范围。

快照目录内容：

- `data/`：源数据按原相对结构复制。
- `config/source.env.backup`：仅在显式传入 `env_file` 时保存；只作为私有档案。
- `snapshot.json`：状态、精确范围、文件大小与 SHA-256、目录集合及整体指纹。

**不要直接把档案里的 source.env.backup 当作启动配置。** 它可能仍指向原实例的数据、
日志、协议端和凭据；本工具不会激活它、创建运行配置或启动任何服务。整个快照
可能包含聊天记录、人格和密钥，应当按私有备份保存，不应提交 Git 或公开分享。
复制得到的 `bot.lock` 也只是归档内容，不证明原进程已退出，不授权解除任何运行锁。

创建时先逐文件读取源 SHA-256，再复制与核对，最后重新扫描源文件集合和哈希。
还会核对打开文件的身份、大小、修改时间，防止复制中途替换或增长。复制完成后，
目标数据也必须与清单逐文件吻合，才能把初始 `incomplete` 状态改为 `complete`。
源发生变化、文件新增/消失、复制失败或校验不符时，保留明确的不完整副本供检查；
校验和派生演练均拒绝使用它。符号链接、Windows 重解析路径和特殊文件会被拒绝。

演练只从校验通过的完整快照派生另一个新目录，再核对相同的文件集合和整体指纹。
它不能覆盖已有实例，不能写进快照目录或原始源数据目录，也不能在原源目录被删除
后将其重新建为演练目标。该流程验证隔离副本可重复还原，不代表已经完成真实运行
实例的停机、切换或回滚验收。

所有返回报告只给常量错误码、计数、指纹与范围摘要，不打印私有路径、正文或密钥。
`ok` 表示当前复制/校验操作结果；`ready` 始终为 `false`。结果中的
`stoppedInstanceVerified: false` 和 `stable_double_scan_only` 明确表示：两次扫描
一致不能代替停写证明。正式切换前仍需停止原实例写入并在该窗口重新制作与验证快照。
