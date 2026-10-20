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
echo [1/4] 当前改动：
git status --short
echo.
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo 没有需要提交的改动。
  goto push
)

set "msg="
set /p msg=提交说明（直接回车用「更新」）: 
if not defined msg set "msg=更新"

echo.
echo [2/4] 提交：%msg%
git commit -m "%msg%"
if errorlevel 1 goto fail

:push
echo.
echo [3/4] 推送到自己的仓库 origin ...
git push origin HEAD:dev
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
