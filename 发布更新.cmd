@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================
echo   QQ Bot 发布更新（提交 + 推送）
echo ==========================================
echo.
for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%B"
echo 当前分支：%BRANCH%
if not "%BRANCH%"=="dev" (
  echo 请切换到 dev 再提交开发更新。main 仅由审核后的发布流程更新。
  goto end
)
echo.
echo [1/4] 凭据与私密文件扫描...
git config core.hooksPath .githooks >nul 2>&1
call npm run check:repo
if errorlevel 1 (
  echo.
  echo 扫描未通过：上面列出的文件不能提交，请先处理再发布。
  goto fail
)
echo.
echo [2/4] 当前改动：
git status --short
echo.
rem 不用 git add -A：个人脚本（plugins/python）和运行数据绝不随发布进公开仓库
git add -A -- . ":(exclude)plugins/python" ":(exclude)data" ":(exclude)logs"
git diff --cached --quiet
if not errorlevel 1 (
  echo 没有需要提交的改动。
  goto push
)

set "msg="
set /p "msg=提交说明（直接回车用「更新」）: "
if not defined msg set "msg=更新"

echo.
echo [3/4] 提交：%msg%
git commit -m "%msg%"
if errorlevel 1 goto fail

:push
echo.
set "PUSH_REMOTE=origin"
git remote get-url upstream >nul 2>&1
if not errorlevel 1 set "PUSH_REMOTE=upstream"
echo [4/4] 推送到 %PUSH_REMOTE%/dev（协作者渠道）...
git push %PUSH_REMOTE% HEAD:dev
if errorlevel 1 goto fail

:done
echo.
echo 完成，最新提交：
git log --oneline -1
echo.
echo 提示：日常开发都在 dev 分支；要合并进上游 main 时，在 GitHub 上开 Pull Request。
goto end

:fail
echo.
echo 出错了：把上面这段发给我。

:end
echo.
pause
