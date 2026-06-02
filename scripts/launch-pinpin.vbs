' 品品 channel 后台启动包装 (隐藏 cmd 窗 + stderr/stdout 重定向到 logs/launcher.log)
' .lnk 指向本 .vbs；WScript.Shell.Run 第二参数 0 = 完全隐藏窗口
' 项目根路径从 WScript.ScriptFullName 反推（scripts/launch-pinpin.vbs -> ..）
Set WshShell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
projectRoot = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
logsDir = projectRoot & "\logs"
If Not fs.FolderExists(logsDir) Then fs.CreateFolder logsDir
WshShell.CurrentDirectory = projectRoot
WshShell.Run "cmd /c npm run launcher:dev > logs\launcher.log 2>&1", 0, False