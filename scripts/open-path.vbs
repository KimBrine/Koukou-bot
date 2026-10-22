Option Explicit
Dim fso, sh, f, target, ts
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
f = "D:\QQ-bot\Koukou-bot\data\open-path.txt"
If Not fso.FileExists(f) Then WScript.Quit 0
Set ts = fso.OpenTextFile(f, 1, False, -1)
target = Trim(ts.ReadAll)
ts.Close
If Len(target) = 0 Then WScript.Quit 0
If fso.FolderExists(target) Then
  sh.Run "explorer.exe """ & target & """", 1, False
ElseIf fso.FileExists(target) Then
  sh.Run "explorer.exe /select,""" & target & """", 1, False
End If
