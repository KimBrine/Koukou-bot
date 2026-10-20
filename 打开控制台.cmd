@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not defined BOT_TASK_NAME set "BOT_TASK_NAME=KoukouQQBot"
set "URL=http://127.0.0.1:8787"
set "PORT=8787"

call :check
if "!UP!"=="1" goto opennow

echo 控制台没在运行，正在启动机器人...
schtasks /run /tn "%BOT_TASK_NAME%" >nul 2>&1
if errorlevel 1 (
  echo [错误] 找不到计划任务 %BOT_TASK_NAME%。
  if not defined NOOPEN pause
  exit /b 1
)
echo 已触发启动，启动完成后控制台会自己弹出来。
exit /b 0

:opennow
if defined NOOPEN exit /b 0
echo 打开 %URL%
start "" %URL%
exit /b 0

:check
set "UP=0"
for /f "tokens=*" %%L in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set "UP=1"
exit /b 0
