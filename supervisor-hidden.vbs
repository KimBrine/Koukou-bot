' Run the minimal bot supervisor with a hidden window (used by the KoukouSupervisor task).
' KEEP THIS FILE ASCII-ONLY: wscript reads .vbs as ANSI, so UTF-8 Chinese comments
' can corrupt parsing and the script silently fails to launch anything.
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""E:\Deepseek Harness Workplace\deepseek-qq-bot\bot-supervisor.ps1"" -Quiet", 0, False
