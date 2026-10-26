# Python 安装包与资源验证

`py` 仍处于迁移验收阶段。wheel 可独立提供控制台预览、迁移清单和 Python 插件 SDK；正式 `run` 入口继续拒绝连接 QQ。

## 安装位置与资源

wheel 包含现有控制台的五个 HTML/CSS/JavaScript 文件、迁移清单、公开版本记录和四个随附 Python 插件。构建时直接从源码的 `src/admin` 与 `plugins/python` 复制，不启动 Node，也不维护另一套前端源码。JavaScript 后端、实例配置、密钥和聊天记录不进入 wheel。

源码检出默认仍以仓库为实例根目录。安装 wheel 后，默认使用稳定的用户目录，不以当前工作目录或只读的 `site-packages` 保存配置：

| 平台 | 默认实例根目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\KoukouStudio` |
| macOS | `~/Library/Application Support/KoukouStudio` |
| Linux | `$XDG_DATA_HOME/koukou-studio`，未设置时为 `~/.local/share/koukou-studio` |

可用 `--root` 显式指定实例根目录，或设置绝对路径的 `KOUKOU_INSTANCE_DIR`。预览数据仍放在该目录内的 `data-python`、`logs-python`，配置为 `data-python/preview.env`。

```powershell
python -m pip install "路径\koukou_bot-0.1.0a1-py3-none-any.whl"
python -m koukou migration
python -m koukou plugin install-bundled
python -m koukou plugin new hello --description "我的插件"
python -m koukou plugin run hello 你好
python -m koukou preview --port 8790
```

`install-bundled` 将 `calc`、`textstats`、`jm`、`jmv` 复制到实例的 `plugins/python`，任何已有同名文件都会保留。第三方插件所需的额外 Python 库、7-Zip 或 RAR 仍需按该插件的说明安装；不会为预览自动运行下载任务。

控制台显示的公开版本来自随包携带的 JavaScript 基线版本，并保留 `python-migration` 后缀。Python 分发包自身的 `0.1.0a1` 元数据不会冒充 main 的正式版本。

## 离线分发验收

构建工具不属于机器人运行依赖。准备构建环境后执行：

```powershell
python -m pip install "setuptools>=77"
python scripts/check-python-distribution.py
```

检查脚本先生成 sdist，再解包到全新临时目录构建 wheel，以免工作区旧 `build` 产物混入。随后使用 `--no-index --no-deps` 安装 wheel，在空目录、无 Node 的 `PATH` 中验证迁移门禁、插件及 SDK、五个控制台资源的 HTTP 访问和实例状态，最后确认安装目录没有被运行过程改写。该检查不连接真实 QQ 或模型接口。

需要保留分发产物时，可另装标准构建前端并使用 `python -m build`。安装包验收不等于真实协议端、模型或生产数据迁移已经验收。
