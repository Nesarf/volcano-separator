' volcano-separator :: launch the activity recorder with no window.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""E:\volcano-separator\bin\activity-watch.ps1"" -LogDir ""D:\DaShaoHuo\cache\tmp\volcano-separator\activity""", 0, False
