' volcano-separator watch heartbeat.
' Runs the CLI with no window. Launched by the scheduled task; see lib/core.mjs installService().
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""E:\volcano-separator\bin\cli.mjs"" heal --quiet --require-dsh", 0, False
