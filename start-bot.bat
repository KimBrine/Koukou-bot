@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title QQ Bot Launcher

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BOTDIR=%ROOT%"
set "BOT_ENV_FILE=%ROOT%\.env"
set "BOT_DATA_DIR=%ROOT%\data"
set "BOT_LOG_DIR=%ROOT%\logs"
set "BOT_PROFILE=main"
set "LAUNCHLOG=%BOT_LOG_DIR%\launcher.log"
if not exist "%BOT_LOG_DIR%" mkdir "%BOT_LOG_DIR%"
if exist "%ROOT%\bot-start.local.bat" call "%ROOT%\bot-start.local.bat"
set "ONEBOT_PORT="
set "CONSOLE_PORT="
for /f "tokens=1,* delims==" %%A in ('node "%ROOT%\scripts\launcher-settings.mjs"') do set "%%A=%%B"
if not defined ONEBOT_PORT exit /b 1
if not defined CONSOLE_PORT exit /b 1

set "LLDIR=%ROOT%\..\luckylillia"
if exist "%ROOT%\llbot_path.txt" set /p LLDIR=<"%ROOT%\llbot_path.txt"
if not exist "%LLDIR%\LuckyLillia.exe" (
  echo [错误] 找不到 LLBot：%LLDIR%
  echo        请把 LLBot 解压到机器人目录旁边，或在 llbot_path.txt 里写一行完整路径。
  pause
  exit /b 1
)

call :mark "启动脚本开始（profile=%BOT_PROFILE%）"
echo ==========================================
echo   QQ Bot 一键启动
echo   代码: %BOTDIR%
echo   LLBot: %LLDIR%
echo ==========================================
echo.

echo [0/3] 清理上一次的机器人实例 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\stop-old-bot.ps1" >nul 2>&1
call :mark "已清理旧实例"

echo [1/3] 启动 LLBot headless（不启动 QQ 客户端）...
set "LLBOT_STARTED=0"
tasklist /FI "IMAGENAME eq LuckyLillia.exe" 2>nul | find /I "LuckyLillia.exe" >nul
if errorlevel 1 (
  cd /d "%LLDIR%\bin\llbot"
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\start-llbot.ps1" -FilePath "%LLDIR%\LuckyLillia.exe"
  set "LLBOT_STARTED=1"
  call :mark "LLBot 已发起启动，等待端口"
) else (
  echo       LLBot 已在运行
  call :mark "LLBot 已在运行"
)

if "%LLBOT_STARTED%"=="1" start "" http://127.0.0.1:3080/
echo       首次使用：用手机 QQ 扫码。扫码后本窗口会自动继续。
echo.

REM ===== 等 OneBot 端口，1 秒一次，最多 120 秒 =====
set /a N=0
:WAITPORT
netstat -ano | findstr /R /C:":%ONEBOT_PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 goto PORTOK
set /a N+=1
if !N! GEQ 120 goto PORTTIMEOUT
ping -n 2 127.0.0.1 >nul
goto WAITPORT
:PORTTIMEOUT
echo.
echo [!] 2 分钟内没等到 OneBot 端口就绪。
echo [!] 请在 http://127.0.0.1:3080 里确认 QQ 已登录，再重新运行本脚本。
call :mark "等待端口超时"
pause
exit /b 1
:PORTOK
call :mark "OneBot 端口就绪（等待 !N! 秒）"
echo       OneBot 端口 %ONEBOT_PORT% 已就绪
echo.

echo [3/3] 启动机器人 ...
cd /d "%BOTDIR%"
start "" http://127.0.0.1:%CONSOLE_PORT%/
call :mark "即将启动 node"
node "%BOTDIR%\src\index.js" --profile=%BOT_PROFILE%
call :mark "node 已退出"

echo.
echo ===== 机器人已退出 =====
echo 日志：%BOTDIR%\logs\bot.log
exit /b 0

:mark
echo [%date% %time%] %~1>>"%LAUNCHLOG%"
exit /b 0
