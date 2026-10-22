Option Explicit
Dim fso, sh, target, mode
If WScript.Arguments.Count <> 2 Then WScript.Quit 2
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
target = WScript.Arguments(0)
mode = WScript.Arguments(1)
If mode = "select" Then
  If Not fso.FileExists(target) Then WScript.Quit 3
  sh.Run "explorer.exe /select,""" & target & """", 1, False
ElseIf mode = "folder" Then
  If Not fso.FolderExists(target) Then WScript.Quit 3
  sh.Run "explorer.exe """ & target & """", 1, False
Else
  WScript.Quit 2
End If
