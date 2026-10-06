# 用 Koukou 练习 Git 和 GitHub

Git 记录本机代码的版本；GitHub 保存远程仓库，让你能查看历史、在别的电脑取回代码、通过分支和 Pull Request 协作。

## 你的项目在哪里

| 名称 | 本项目的设置 |
| --- | --- |
| 本地仓库 | `E:\Deepseek Harness Workplace\deepseek-qq-bot` |
| GitHub 仓库 | <https://github.com/KimBrine/Koukou.> |
| 默认分支 | `main` |
| 远程名称 | `origin`，指向上面的 GitHub 仓库 |

在 PowerShell 中进入代码目录：

```powershell
Set-Location 'E:\Deepseek Harness Workplace\deepseek-qq-bot'
git status
git log --oneline -5
```

`git status` 看有没有未提交的改动；`git log` 查看已提交的历史。这个仓库接续了 GitHub 上原来的提交历史。

## 日常流程：修改 → 暂存 → 提交 → 上传

例如修改了 `README.md`：

```powershell
git diff -- README.md
git add README.md
git diff --cached
git commit -m "docs: 更新使用说明"
git push
```

每条命令的作用：

| 命令 | 作用 |
| --- | --- |
| `git diff` | 看本机还没暂存的改动 |
| `git add 文件` | 把选中的改动放入暂存区，准备提交 |
| `git diff --cached` | 看这次提交会包含的内容 |
| `git commit -m "说明"` | 在本机保存一个有说明的版本 |
| `git push` | 把本机的新提交上传 GitHub |

提交只发生在本机，推送成功后 GitHub 才能看到新提交。建议每次提交解决一个具体问题，如「修复群总结昵称」或「调整启动窗口按钮」。

修改机器人代码后，先运行 `npm test`。提交钩子会检查暂存区中的凭据和运行数据；你也可以手动运行 `npm run check:repo`。

## 第一次练习：用分支改一段文档

下面的练习会新建自己的练习分支。先确保 `git status` 没有待处理的修改：

```powershell
git switch -c practice/git-notes
notepad docs/GIT-GITHUB.md
```

在文档末尾添加一小段自己的学习笔记，保存后执行：

```powershell
git diff -- docs/GIT-GITHUB.md
git add docs/GIT-GITHUB.md
git commit -m "docs: 添加我的 Git 学习笔记"
git push -u origin practice/git-notes
```

`-u` 给这个分支设置对应的远程分支，以后在该分支上直接 `git push` 即可。

打开 GitHub 仓库，选择刚上传的分支，点击 **Compare & pull request**。查看 **Files changed**，确认内容，再创建 Pull Request。合并后回到本机：

```powershell
git switch main
git pull --ff-only
```

Pull Request 是把分支改动合入主分支前的一次可查看、可讨论的变更申请。练习文档比较适合入门；切换包含机器人代码改动的分支前，先在控制台停止机器人，确认好版本后再启动。

## 从 GitHub 取回更新

在本机没有未提交改动时：

```powershell
git pull --ff-only
```

如果提示不能快进，或者 `git status` 显示有本地修改，先检查两边的改动，再决定如何合并。已经提交但希望撤销的修改，可以用 `git revert 提交号` 生成一个撤销提交，然后正常推送。

只是误把某个文件加入暂存区，可以执行：

```powershell
git restore --staged README.md
```

这会取消暂存，保留文件里的修改。

## 本机配置与账号数据

`.env`、`launcher.local.json`、QQ 登录态、聊天记录、记忆、日志和图片缓存由 `.gitignore` 忽略。GitHub 上提供空密钥的配置示例，真实配置继续保存在本机。

当前账号的数据目录是 `E:\Deepseek Harness Workplace\deepseek-qq-bot-2`；本仓库管理共享代码。详细位置见 [Windows 部署说明](WINDOWS-SETUP.md)。

新克隆的仓库需要开启本项目的提交检查钩子：

```powershell
git config core.hooksPath .githooks
```

在新电脑取回仓库，填写自己的配置，再运行机器人；Git 上传和下载代码不会自动部署，也不会替你登录 QQ。

## GitHub 连接

本机 Git 使用 Windows 的 Git Credential Manager 管理登录凭据。仓库地址里无需写入 Token；要求登录时使用它提供的登录流程。

这份本地仓库已设置 GitHub 连接使用 Clash Verge 的 `7897` 端口，因此普通 `git push` 也会使用它。代理需保持运行。若在其他目录使用 Git，可以临时让这一条命令通过已有本地代理连接：

```powershell
git -c http.proxy=http://127.0.0.1:7897 push
```

代理设置仅保存在本地 Git 配置中。换电脑时需使用对应配置；若以后可以直连 GitHub，可删除本仓库的代理设置：

```powershell
git config --unset 'http.https://github.com/.proxy'
```

## GitHub 发来的自动检查邮件

仓库的 **Actions → Offline checks** 会在上传代码后，用 GitHub 提供的 Windows 和 Linux 电脑检查提交文件并运行离线测试。它们使用空配置，不连接你的 QQ，也不会调用付费模型。

| 页面提示 | 含义 |
| --- | --- |
| `Triggered via push` | 这次上传代码触发了检查 |
| `Success` / 绿色勾 | 所有检查通过 |
| `Failure` / 红色叉 | 至少一个步骤失败，点击对应任务查看日志 |
| `Cancelled` | 任务被取消，不能单靠它判断测试是否通过 |
| `Annotations` | 汇总具体错误或警告 |
| `Re-run jobs` | 对同一个提交重跑；修改配置后应查看新提交对应的运行 |

失败邮件表示云端自动检查有问题；代码是否上传成功，要查看仓库提交记录。电脑上正在运行的机器人由本地启动程序管理。

本仓库名 `Koukou.` 以句点结尾，Windows 默认检查目录会遇到路径兼容问题。工作流在 Windows 临时目录中取代码，Linux 使用普通 checkout；两个系统独立完成检查。旧运行的失败记录仍会保留，修复后看最新提交对应的结果。

## 官方参考

- [Git 中文手册：记录每次更新到仓库](https://git-scm.com/book/zh/v2/Git-%E5%9F%BA%E7%A1%80-%E8%AE%B0%E5%BD%95%E6%AF%8F%E6%AC%A1%E6%9B%B4%E6%96%B0%E5%88%B0%E4%BB%93%E5%BA%93)
- [GitHub：推送提交到远程仓库](https://docs.github.com/zh/get-started/using-git/pushing-commits-to-a-remote-repository)
