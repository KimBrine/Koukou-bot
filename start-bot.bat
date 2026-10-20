@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title QQ Bot Launcher

REM ===== 路径：脚本自己所在目录 = 机器人代码目录 =====
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BOTDIR=%ROOT%"
set "BOT_ENV_FILE=%ROOT%\.env"
set "BOT_DATA_DIR=%ROOT%\data"
set "BOT_LOG_DIR=%ROOT%\logs"
set "BOT_PROFILE=main"
if exist "%ROOT%\bot-start.local.bat" call "%ROOT%\bot-start.local.bat"
set "ONEBOT_PORT="
set "CONSOLE_PORT="
for /f "tokens=1,* delims==" %%A in ('node "%ROOT%\scripts\launcher-settings.mjs"') do set "%%A=%%B"
if not defined ONEBOT_PORT exit /b 1
if not defined CONSOLE_PORT exit /b 1

REM ===== LLBot 目录：优先读 llbot_path.txt，其次 ..\luckylillia =====
set "LLDIR=%ROOT%\..\luckylillia"
if exist "%ROOT%\llbot_path.txt" set /p LLDIR=<"%ROOT%\llbot_path.txt"
if not exist "%LLDIR%\LuckyLillia.exe" (
  echo [错误] 找不到 LLBot：%LLDIR%
  echo        请把 LLBot 解压到机器人目录旁边，或在 llbot_path.txt 里写一行完整路径。
  echo        下载：https://github.com/LLOneBot/LuckyLilliaBot/releases
  pause
  exit /b 1
)

echo ==========================================
echo   QQ Bot 一键启动
echo   代码: %BOTDIR%
echo   LLBot: %LLDIR%
echo ==========================================
echo.

echo [0/3] 清理上一次的机器人实例 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\stop-old-bot.ps1" >nul 2>&1

echo [1/3] 启动 LLBot headless（不启动 QQ 客户端）...
tasklist /FI "IMAGENAME eq LuckyLillia.exe" 2>nul | find /I "LuckyLillia.exe" >nul
if errorlevel 1 (
  cd /d "%LLDIR%\bin\llbot"
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\start-llbot.ps1" -FilePath "%LLDIR%\LuckyLillia.exe"
  timeout /t 12 /nobreak >nul
) else (
  echo       LLBot 已在运行
)

echo [2/3] 打开扫码页面 http://127.0.0.1:3080
start "" http://127.0.0.1:3080/
echo       首次使用：用手机 QQ 扫码。扫码后本窗口会自动继续。
echo.

set /a N=0
:WAITPORT
set /a N+=1
netstat -ano | findstr /R /C:":%ONEBOT_PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 goto PORTOK
if !N! GEQ 100 goto PORTTIMEOUT
timeout /t 3 /nobreak >nul
goto WAITPORT
:PORTTIMEOUT
echo.
echo [!] 5 分钟内没等到登录完成。
echo [!] 请在 http://127.0.0.1:3080 里确认 QQ 已扫码登录，再重新运行本脚本。
pause
exit /b 1
:PORTOK
echo       OneBot 端口 %ONEBOT_PORT% 已就绪，实际 QQ 在线状态请查看控制台
echo.

echo [3/3] 启动机器人 ...
cd /d "%BOTDIR%"
start "" http://127.0.0.1:%CONSOLE_PORT%/
node "%BOTDIR%\src\index.js" --profile=%BOT_PROFILE% 1>nul 2>>"%BOT_LOG_DIR%\console-err.log"

echo.
echo ===== 机器人已退出 =====
echo 日志：%BOTDIR%\logs\bot.log
timeout /t 30 /nobreak >nul
