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
  echo [ERROR] LLBot not found: %LLDIR%
  echo         Put LLBot next to this folder, or write its full path in llbot_path.txt.
  pause
  exit /b 1
)

call :mark "launcher start (profile=%BOT_PROFILE%)"
echo ==========================================
echo   QQ Bot Launcher
echo   Code : %BOTDIR%
echo   LLBot: %LLDIR%
echo ==========================================
echo.

echo [0/3] Clean previous instance ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\stop-old-bot.ps1" >nul 2>&1
call :mark "cleaned previous instance"

echo [1/3] Start LLBot headless ...
set "LLBOT_STARTED=0"
netstat -ano | findstr /R /C:":%ONEBOT_PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo       OneBot port already up, skip LLBot start
  call :mark "OneBot port already up, skip LLBot"
  goto WAITPORT
)
wscript //B //Nologo "%ROOT%\scripts\start-llbot-hidden.vbs" "%LLDIR%\LuckyLillia.exe" "%LLDIR%\bin\llbot" "%LLBOT_QQ%"
set "LLBOT_STARTED=1"
call :mark "LLBot launch requested, waiting for port"
echo       First run: scan QR in console "QQ Login" page. This window shows progress.
echo.

set /a N=0
:WAITPORT
netstat -ano | findstr /R /C:":%ONEBOT_PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 goto PORTOK
set /a N+=1
if !N! GEQ 120 goto PORTTIMEOUT
set /a MOD=N %% 10
if !MOD!==0 echo       Waited !N!s, still waiting for OneBot port ...
ping -n 2 127.0.0.1 >nul
goto WAITPORT
:PORTTIMEOUT
echo.
echo [!] OneBot port not ready in 120s.
echo [!] Check QQ login in console, then run this script again.
call :mark "port wait timeout"
pause
exit /b 1
:PORTOK
call :mark "OneBot port ready (waited !N!s)"
echo       OneBot port %ONEBOT_PORT% is ready
echo.

echo [3/3] Start bot ...
cd /d "%BOTDIR%"
start "" http://127.0.0.1:%CONSOLE_PORT%/
call :mark "starting node"
node "%BOTDIR%\src\index.js" --profile=%BOT_PROFILE%
call :mark "node exited"

echo.
echo ===== Bot exited =====
echo Log: %BOTDIR%\logs\bot.log
exit /b 0

:mark
echo [%date% %time%] %~1>>"%LAUNCHLOG%"
exit /b 0