@echo off
chcp 65001 >nul
set "BOT_ENV_FILE=%~dp0.env"
set "BOT_DATA_DIR=%~dp0data"
set "BOT_LOG_DIR=%~dp0logs"
set "BOT_PROFILE=main"
rem Optional instance overrides; this file is excluded from Git.
if exist "%~dp0bot-start.local.bat" call "%~dp0bot-start.local.bat"
cd /d "%~dp0"
if not exist "%BOT_LOG_DIR%" mkdir "%BOT_LOG_DIR%"
node "%~dp0src\index.js" --profile=%BOT_PROFILE% >> "%BOT_LOG_DIR%\console.log" 2>&1
