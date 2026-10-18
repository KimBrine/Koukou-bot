@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title QQ Bot Launcher

REM ===== 路径：脚本自己所在目录 = 机器人代码目录 =====
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BOTDIR=%ROOT%"

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
  start "LLBot" /min "%LLDIR%\LuckyLillia.exe" --headless
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
netstat -ano | findstr /R /C:":3001 .*LISTENING" >nul 2>&1
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
echo       登录成功，OneBot 端口 3001 已就绪
echo.

echo [3/3] 启动机器人 ...
cd /d "%BOTDIR%"
start "" http://127.0.0.1:8787/
node src\index.js

echo.
echo ===== 机器人已退出 =====
echo 日志：%BOTDIR%\logs\bot.log
timeout /t 30 /nobreak >nul
