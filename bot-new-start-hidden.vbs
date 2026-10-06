' Start BOT INSTANCE 2 (new account 3399202820) with a hidden window.
' Used by the scheduled task DeepSeekQQBotNew.
' KEEP THIS FILE ASCII-ONLY: wscript reads .vbs as ANSI, so UTF-8 Chinese comments
' can corrupt parsing and the script silently fails to launch anything.
' Redirection lives in bot-start-2.bat (WScript.Shell.Run does not hand ">>" to cmd).
CreateObject("WScript.Shell").Run """E:\Deepseek Harness Workplace\deepseek-qq-bot\bot-start-2.bat""", 0, False
