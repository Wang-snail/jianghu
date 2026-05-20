; Jianghu Windows Installer (NSIS)
; Build: makensis /DVERSION=x.x.x /DOUT_FILE=out.exe /DSTAGING_DIR=staging\zuzu jianghu.nsi

!include "MUI2.nsh"

Name "江湖"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES\Jianghu"
InstallDirRegKey HKLM "Software\Jianghu" "InstallDir"
RequestExecutionLevel admin

; Version info
VIProductVersion "${VI_VERSION}"
VIAddVersionKey "ProductName" "江湖"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "江湖 - 本地 AI 数字组织生态系统"
VIAddVersionKey "LegalCopyright" "MIT License"

; Modern UI
!define MUI_ABORTWARNING

; Welcome copy
!define MUI_WELCOMEPAGE_TEXT "安装程序会添加 zuzu 命令并启动江湖本地服务。$\r$\n$\r$\n安装完成后浏览器会打开 http://localhost:4700。$\r$\n$\r$\n以后可从开始菜单 -> 江湖 -> 打开江湖 重新启动。$\r$\n$\r$\n委托、帮派、弟子、功法和钱庄流水默认保存在本机。"

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE FinishPageLeave
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetRegView 64
  SetOutPath "$INSTDIR"

  ; Stop running Jianghu processes from previous installs to avoid locked files.
  Call StopRunningJianghu
  Sleep 500

  ; Copy all files from staging
  File /r "${STAGING_DIR}\*.*"

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Cleanup old launcher names from previous versions
  RMDir /r "$SMPROGRAMS\Jianghu"
  Delete "$DESKTOP\Jianghu.lnk"

  ; Start Menu
  CreateDirectory "$SMPROGRAMS\江湖"
  Call CreateTrayScript
  Call CreateLauncherScript
  CreateShortcut "$SMPROGRAMS\江湖\打开江湖.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\bin\jianghu-launch.vbs"' "$INSTDIR\ui\jianghu-server.ico" 0
  CreateShortcut "$SMPROGRAMS\江湖\卸载.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\江湖.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\bin\jianghu-launch.vbs"' "$INSTDIR\ui\jianghu-server.ico" 0

  ; Add bin\ to system PATH via registry
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ; Only add if not already present
  StrCpy $1 "$INSTDIR\bin"
  Push $0
  Push $1
  Call StrContains
  Pop $2
  StrCmp $2 "" 0 +2
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0;$1"

  ; Notify shell of environment change
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Add/Remove Programs registry
  WriteRegStr HKLM "Software\Jianghu" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jianghu" \
    "DisplayName" "江湖"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jianghu" \
    "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jianghu" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jianghu" \
    "Publisher" "江湖"
SectionEnd

Section "Uninstall"
  SetRegView 64
  ; Remove bin\ from system PATH
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ; Remove ;$INSTDIR\bin or $INSTDIR\bin; from PATH
  StrCpy $1 "$INSTDIR\bin"
  Push $0
  Push ";$1"
  Call un.StrReplace
  Pop $0
  Push $0
  Push "$1;"
  Call un.StrReplace
  Pop $0
  Push $0
  Push "$1"
  Call un.StrReplace
  Pop $0
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Remove files
  RMDir /r "$INSTDIR"

  ; Remove Start Menu
  RMDir /r "$SMPROGRAMS\江湖"
  RMDir /r "$SMPROGRAMS\Jianghu"
  Delete "$DESKTOP\江湖.lnk"
  Delete "$DESKTOP\Jianghu.lnk"

  ; Remove registry
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Jianghu"
  DeleteRegKey HKLM "Software\Jianghu"
SectionEnd

; --- Launch server + browser ---

Function LaunchJianghu
  ; Run launcher via Windows Script Host so the local server stays hidden.
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\bin\jianghu-launch.vbs"'
FunctionEnd

Function .onInit
  SetRegView 64
  StrCmp $PROGRAMFILES64 "" +2 0
    StrCpy $INSTDIR "$PROGRAMFILES64\Jianghu"

  Push $INSTDIR
  Push "\AppData\Local\Temp\"
  Call StrContains
  Pop $0
  StrCmp $0 "" +2 0
    StrCpy $INSTDIR "$PROGRAMFILES\Jianghu"

  Push $INSTDIR
  Push "\Temp\jianghu-"
  Call StrContains
  Pop $0
  StrCmp $0 "" +2 0
    StrCpy $INSTDIR "$PROGRAMFILES\Jianghu"
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

; Launch automatically when the user leaves the Finish page.
Function FinishPageLeave
  Call LaunchJianghu
FunctionEnd

; --- Helper functions ---

Function CreateLauncherScript
  FileOpen $0 "$INSTDIR\bin\jianghu-launch.vbs" w
  FileWrite $0 "Set app = CreateObject($\"Shell.Application$\")$\r$\n"
  FileWrite $0 "Set fso = CreateObject($\"Scripting.FileSystemObject$\")$\r$\n"
  FileWrite $0 "scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)$\r$\n"
  FileWrite $0 "psPath = scriptDir & $\"\\jianghu-tray.ps1$\"$\r$\n"
  FileWrite $0 "args = $\"-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File $\" & Chr(34) & psPath & Chr(34) & $\" -OpenWhenReady$\"$\r$\n"
  FileWrite $0 "app.ShellExecute $\"powershell.exe$\", args, $\"$\", $\"open$\", 0$\r$\n"
  FileClose $0
FunctionEnd

Function CreateTrayScript
  File "/oname=$INSTDIR\bin\jianghu-tray.ps1" "..\..\installers\windows\jianghu-tray.ps1"
FunctionEnd

Function StopRunningJianghu
  InitPluginsDir
  File "/oname=$PLUGINSDIR\jianghu-stop.ps1" "..\..\installers\windows\stop-jianghu.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\jianghu-stop.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Delete "$PLUGINSDIR\jianghu-stop.ps1"
FunctionEnd

; StrContains - check if $1 is in $0 (push haystack, needle)
Function StrContains
  Exch $R1 ; needle
  Exch
  Exch $R0 ; haystack
  Push $R2
  Push $R3
  Push $R4
  StrLen $R3 $R1
  StrCpy $R4 0
  loop:
    StrCpy $R2 $R0 $R3 $R4
    StrCmp $R2 "" notfound
    StrCmp $R2 $R1 found
    IntOp $R4 $R4 + 1
    Goto loop
  found:
    StrCpy $R0 $R1
    Goto done
  notfound:
    StrCpy $R0 ""
  done:
    Pop $R4
    Pop $R3
    Pop $R2
    Exch $R0
FunctionEnd

; StrReplace - replace all occurrences (push string, old, returns new on stack)
Function un.StrReplace
  Exch $R1 ; old
  Exch
  Exch $R0 ; string
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R5 ""
  StrCpy $R4 0
  loop:
    StrCpy $R2 $R0 $R3 $R4
    StrCmp $R2 "" done
    StrCmp $R2 $R1 replace
    StrCpy $R2 $R0 1 $R4
    StrCpy $R5 "$R5$R2"
    IntOp $R4 $R4 + 1
    Goto loop
  replace:
    IntOp $R4 $R4 + $R3
    Goto loop
  done:
    StrCpy $R0 $R5
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Exch $R0
FunctionEnd
