' Hidden supervisor entry; instance settings are in windows.local.json.
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\bot-supervisor.ps1"" -Quiet", 0, False
