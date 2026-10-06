' Open the control console of BOT INSTANCE 2 (new account 3399202820) with a hidden window.
' KEEP THIS FILE ASCII-ONLY: wscript reads .vbs as ANSI, UTF-8 Chinese comments
' break parsing and the shortcut silently does nothing.
' Instance 1 has its own launcher (console-app.ps1 with default port 8787).
' This one is port 8788, read from the instance 2 .env file.
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""E:\Deepseek Harness Workplace\deepseek-qq-bot\console-app.ps1"" -EnvFile ""E:\Deepseek Harness Workplace\deepseek-qq-bot-2\.env"" -TaskName DeepSeekQQBotNew -Title ""Koukou 2""", 0, False
