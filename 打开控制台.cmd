@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM 任务名可用环境变量覆盖；默认 KoukouQQBot
if not defined BOT_TASK_NAME set "BOT_TASK_NAME=KoukouQQBot"
set "URL=http://127.0.0.1:8787"
set "PORT=8787"

call :check
if "!UP!"=="1" goto open

echo 控制台没在运行，正在启动机器人...
schtasks /run /tn "%BOT_TASK_NAME%" >nul 2>&1
if errorlevel 1 (
  echo [错误] 找不到计划任务 %BOT_TASK_NAME%。
  echo        请改用 start-bot.bat 启动，或检查任务名。
  if not defined NOOPEN pause
  exit /b 1
)

set /a N=0
:wait
set /a N+=1
ping -n 4 127.0.0.1 >nul
call :check
if "!UP!"=="1" goto open
if !N! GEQ 40 (
  echo [错误] 等待 2 分钟仍未就绪。
  echo        日志：%~dp0logs\bot.log
  if not defined NOOPEN pause
  exit /b 1
)
goto wait

:open
echo 控制台地址：%URL%
if defined NOOPEN exit /b 0
REM 优先用 Edge 的应用模式，看起来像独立窗口；没有 Edge 就用默认浏览器
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL%
) else (
  start "" %URL%
)
exit /b 0

:check
set "UP=0"
for /f "tokens=*" %%L in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set "UP=1"
exit /b 0
