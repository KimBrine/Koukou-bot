@echo off
rem ============================================================================
rem  Start BOT INSTANCE 2 (new account 3399202820, NapCat at E:\NapCatQQ2).
rem
rem  Both instances run the SAME code from this directory. Only the config,
rem  data and log directories differ - never copy the code directory, otherwise
rem  every future bug fix has to be applied twice.
rem
rem  ASCII only + CRLF: cmd reads .bat as ANSI, so UTF-8 Chinese breaks it.
rem  Do not put the ">>" redirection in the .vbs launcher: WScript.Shell.Run
rem  does not hand it to cmd and the process would never start.
rem ============================================================================
chcp 65001 >nul
set BOT_ENV_FILE=E:\Deepseek Harness Workplace\deepseek-qq-bot-2\.env
set BOT_DATA_DIR=E:\Deepseek Harness Workplace\deepseek-qq-bot-2\data
set BOT_LOG_DIR=E:\Deepseek Harness Workplace\deepseek-qq-bot-2\logs
set BOT_PROFILE=new
cd /d "E:\Deepseek Harness Workplace\deepseek-qq-bot"
if not exist "E:\Deepseek Harness Workplace\deepseek-qq-bot-2\logs" mkdir "E:\Deepseek Harness Workplace\deepseek-qq-bot-2\logs"
node src\index.js --profile=new >> "E:\Deepseek Harness Workplace\deepseek-qq-bot-2\logs\console.log" 2>&1
