' Launch LLBot hidden (no PowerShell). Args: exePath workDir [uin] [debug]
Dim sh, exePath, workDir, extra, uin, debugArg
If WScript.Arguments.Count < 2 Then WScript.Quit 2
Set sh = CreateObject("WScript.Shell")
exePath = WScript.Arguments(0)
workDir = WScript.Arguments(1)
extra = ""
If WScript.Arguments.Count >= 3 Then
  uin = Trim(WScript.Arguments(2))
  If uin <> "" Then extra = " --qq " & uin
End If
debugArg = ""
If WScript.Arguments.Count >= 4 Then
  If Trim(WScript.Arguments(3)) <> "" Then debugArg = " --debug"
End If
sh.CurrentDirectory = workDir
sh.Run """" & exePath & """ --headless" & extra & debugArg, 0, False