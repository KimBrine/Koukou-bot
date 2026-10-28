' Hidden launcher for NapCat: wscript //B start-napcat-hidden.vbs <launcher.bat> <workdir>
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then WScript.Quit 2
launcher = WScript.Arguments(0)
workdir = WScript.Arguments(1)
sh.CurrentDirectory = workdir
sh.Run "cmd /c """ & launcher & """", 0, False
