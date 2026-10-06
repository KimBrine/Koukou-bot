' Hidden entry; resolve the script directory so the checkout can be moved.
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & root & "\bot-start-2.bat""", 0, False
