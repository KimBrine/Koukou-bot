' 隐藏窗口启动 LLBot（不经过 PowerShell，避免冷启动慢和多余控制台）
' 用法：wscript //B //Nologo start-llbot-hidden.vbs <exe路径> <工作目录>
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then WScript.Quit 2
exePath = WScript.Arguments(0)
workDir = WScript.Arguments(1)
sh.CurrentDirectory = workDir
sh.Run """" & exePath & """ --headless", 0, False
