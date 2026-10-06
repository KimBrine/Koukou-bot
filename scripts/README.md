# 调试与维护脚本

`npm test` 仅运行 `test-offline.mjs` 中明确列出的离线测试：群总结、定时补发、在线判定、纯文字 +1、图片缓存及会话管理。测试中的账号、昵称和群号为虚构样例。

其他 `probe-*`、`check-*`、历史 `test-*` 和 `seed-*` 脚本可能连接 OneBot、调用付费模型、读取消息、发送消息或修改数据。它们不会自动进入离线测试，使用前请检查代码及目标参数。

- 密钥通过 `src/config.js` 读取 `.env` / `BOT_ENV_FILE`，不要写进源码。
- 需要真实接口的探针使用 `--group=<群号>` / `--user=<QQ号>` 或 `PROBE_GROUP_ID` / `PROBE_USER_ID` 指定目标。保留原位置参数的脚本按其用法传入，测试样例不代表部署参数。
- `seed-*`、`clean-*`、`merge-instance-data.mjs` 会修改数据；确认目标实例并先备份。
- `leave-all-groups.mjs`、群成员操作等维护脚本需要明确理解其实际动作。
- `gen-face-table.mjs <qface-*.js 路径>` 从指定 NapCat 静态资源生成表情映射。
- `check-repository.mjs --staged` 检查即将提交的文件；`--head` 检查当前提交。
