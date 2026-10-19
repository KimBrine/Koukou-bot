@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================
echo   QQ Bot 发布更新（提交 + 推送到 GitHub）
echo ==========================================
echo.
echo [1/4] 当前改动：
git status --short
echo.
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo 没有需要提交的改动。
  goto end
)

set "msg="
set /p msg=提交说明（直接回车用「更新」）: 
if not defined msg set "msg=更新"

echo.
echo [2/4] 提交：%msg%
git commit -m "%msg%"
if errorlevel 1 goto fail

echo.
echo [3/4] 推送到 GitHub ...
git push origin main
if errorlevel 1 goto fail

echo.
echo [4/4] 完成，最新提交：
git log --oneline -1
goto end

:fail
echo.
echo 出错了：把上面这段发给我。

:end
echo.
pause
