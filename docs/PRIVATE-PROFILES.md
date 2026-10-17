# 私有资料与公开默认值

## 发布边界

仓库提供功能代码、通用默认人格和通用拍一拍语料。QQ、NapCat 需另行安装；网页控制台是机器人程序的一部分，启用与否由 `ADMIN_ENABLED` 决定。安装控制台或启动中心不会导入个人预设。

每个实例的数据目录由 `BOT_DATA_DIR` 指定，默认是仓库下被 Git 忽略的 `data/`。以下资料只属于当前实例：

| 路径（相对于数据目录） | 内容 |
| --- | --- |
| `personas/*.txt` | 控制台导入、新建的人格 |
| `persona.txt` | 可选的实例默认人格；优先于仓库通用模板 |
| `poke-replies.txt` | 可选的私有拍一拍语料；优先于仓库通用语料 |
| `profile.local.json` | 可选的专属聊天规则、装饰偏好和读图失败后备用短句 |
| `vision-knowledge/` | 人工标注、参考图片、辨认规则与图片哈希 |
| 其他记忆、缓存、日报与备份文件 | 实例运行数据 |

仓库根目录旧的 `personas/`、`private/` 及各层 `vision-knowledge/`、`training-data/`、`reference-images/` 同样不允许提交。通用识图标注功能保留在代码中，未提供实例资料时不会加载候选角色、参考图或预置哈希。

## 默认值与显式启用

新实例不设置 `ACTIVE_PERSONA`，自动使用通用助手模板；模板中的 `{{BOT_NAME}}` 使用当前实例的机器人名称。人格导入默认只保存，点击“切换使用”才激活。参考包应由部署者自己保存、导入并确认使用，不能把它指定为所有用户的默认值。

人格读取顺序：`PERSONA` → `ACTIVE_PERSONA` 指定的实例人格 → `PERSONA_FILE` → 实例的 `persona.txt` → 仓库通用 `persona.txt`。显式选定的人格丢失或为空时启动报错，避免悄悄换成另一人格。

`PERSONA_DIR` 可指定私有人格库；`PERSONA_FILE`、`PERSONA_DIR`、`POKE_REPLIES_FILE` 的相对路径以实例 `.env` 所在目录为准。控制台编辑和启动读取使用同一人格库。

## 专属风格示例

默认没有 `profile.local.json`。需要时由部署者在自己的数据目录创建，例如：

```json
{
  "conversationRules": "附加的本实例聊天规则。根据当前话题自然接话。",
  "decoration": {
    "symbol": "⭐",
    "kaomoji": [":)"],
    "weights": {"emoji": 0.7, "kaomoji": 0.2, "both": 0.1},
    "voiceHint": "语气自然，少量使用装饰。"
  },
  "imageFallbackReplies": ["这张图挺有意思。"]
}
```

`conversationRules` 提供时替换通用衔接规则，请自行保留需要的上下文与事实边界。未提供装饰偏好时不会硬补固定符号。资料只在启动时读取，修改后重新加载机器人。格式错误会明确报错。

## 从 1.x 升级

1. **拉取新版前**备份自己修改过的根目录 `persona.txt`、`poke-replies.txt` 和 `personas/`。这些旧文件曾属于源码，不能依靠 Git 忽略规则保留旧内容。
2. 将默认人格和拍一拍语料放入目标实例的数据目录，将人格库放入数据目录的 `personas/`。多个实例分别复制，不共用个人资料。
3. 可设置好 `BOT_ENV_FILE`、`BOT_DATA_DIR` 后，显式运行 `node scripts/migrate-personas.mjs --source=备份目录`。脚本只复制 `.txt`，不覆盖同名文件，不改 `.env`，不自动激活。
4. 核对原 `ACTIVE_PERSONA` 指定的文件已迁移后再启动。既有的 `vision-knowledge/`、聊天记忆和总结数据无需改动。
5. 仓库的公开默认值不等于生产实例的私有设置；更新代码不应覆盖实例目录中的自定义内容。

提交前运行 `npm run check:repo`。本地还可用 `git config --add koukou.privateContentFile "私有文件完整路径"` 注册需保护的文本或图片；扫描会阻止完整内容、相同文件或参考图片被换名提交。真实部署配置、资料和注册路径不能写进公共配置。

新版只清理当前发布树中的专属默认资料，不重写既有 Git 历史；旧提交可能仍包含当时发布过的人格。尚未提交过的私有图片、标注和聊天数据不会因推送源码而上传。
