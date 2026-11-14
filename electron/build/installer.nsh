; Deep Student — 自定义 NSIS 安装钩子（electron-builder 26，`nsis.include`）。
;
; 跨架构迁移背景：0.15.x 及更早的 Tauri 版 NSIS 安装器由 updater 下载并启动
; 0.20.0 的 Electron NSIS 安装包，启动参数为 `/UPDATE`。此时必须：
;   1) 进入静默模式（不显示任何向导页与完成页）；
;   2) 结束仍在运行的旧版 `deep-student.exe`，并调用 Tauri 自己的卸载器清掉
;      旧文件、快捷方式与卸载注册项；
;   3) 照常安装 Electron 0.20.0；
;   4) 安装结束后重新启动 `$INSTDIR\Deep Student.exe`。
;
; 用户手动双击安装包（没有 `/UPDATE`）时行为完全不变，仍走 assisted 安装向导。
;
; `FileFunc.nsh`（`${GetParameters}` / `${GetOptions}`）由 electron-builder 的
; `multiUser.nsh` 引入；`LogicLib`（`${IfNot}` / `${Errors}`）由 `UAC.nsh` 引入。
; 两者都在 `.onInit` 插入点之前加载，因此本文件不重复 `!include`，避免与模板
; 重复定义。

; 查找遗留 Tauri NSIS 卸载程序路径并规范为无引号路径写入 $R7，找不到则置空。
!macro _dsFindTauriUninstaller ROOT KEY PATH_FALLBACK OUT_VAR
  ReadRegStr ${OUT_VAR} ${ROOT} "${KEY}" "UninstallString"
  ${If} ${OUT_VAR} == ""
    ${If} ${FileExists} "${PATH_FALLBACK}"
      StrCpy ${OUT_VAR} "${PATH_FALLBACK}"
    ${EndIf}
  ${Else}
    ; 注册表 UninstallString 通常带双引号，先尝试提取引号内路径；无引号时保留原串。
    Push ${OUT_VAR}
    Call GetInQuotes
    Pop $R9
    ${If} $R9 != ""
      StrCpy ${OUT_VAR} $R9
    ${EndIf}
  ${EndIf}
  ${If} ${OUT_VAR} != ""
    ${IfNot} ${FileExists} "${OUT_VAR}"
      StrCpy ${OUT_VAR} ""
    ${EndIf}
  ${EndIf}
!macroend

; 以 _?= 同步执行复制后的 NSIS 卸载器，避免原目录卸载器自拷贝异步退出或文件锁残留。
!macro _dsRunTauriUninstaller UNINST_PATH
  ${If} "${UNINST_PATH}" != ""
    ${StdUtils.GetParentPath} $R8 "${UNINST_PATH}"
    CopyFiles /SILENT "${UNINST_PATH}" "$TEMP\ds_tauri_uninst.exe"
    ${If} ${FileExists} "$TEMP\ds_tauri_uninst.exe"
      ExecWait '"$TEMP\ds_tauri_uninst.exe" /S _?=$R8'
      Delete "$TEMP\ds_tauri_uninst.exe"
    ${Else}
      ExecWait '"${UNINST_PATH}" /S _?=$R8'
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    ; Tauri updater 触发的迁移升级：全程静默，避免弹出第二个安装向导。
    SetSilent silent

    ; 若旧版 Tauri 安装为 per-machine（HKLM / Program Files），当前 per-user 安装器处于 MediumIL，
    ; 必须先提权才能静默卸载 Program Files 与 HKLM 注册表项；Electron 自身仍按当前用户安装到 %LOCALAPPDATA%。
    !insertmacro _dsFindTauriUninstaller HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Deep Student" "$PROGRAMFILES64\Deep Student\uninstall.exe" $R6
    ${If} $R6 == ""
      !insertmacro _dsFindTauriUninstaller HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\deep-student" "$PROGRAMFILES64\deep-student\uninstall.exe" $R6
    ${EndIf}
    ${If} $R6 != ""
      ${IfNot} ${UAC_IsAdmin}
        ShowWindow $HWNDPARENT ${SW_HIDE}
        !insertmacro UAC_RunElevated
        ${Switch} $0
          ${Case} 0
            ${Break}
          ${Case} 1223
            ${Break}
          ${Default}
            ${Break}
        ${EndSwitch}
        Quit
      ${EndIf}
    ${EndIf}

    ; updater 启动安装器后执行有序退出，留出保存草稿与关停 Host 的时间。
    ; 最多等待 15 秒，只有超时仍存活的进程才强制结束。
    StrCpy $R3 0
    ds_update_wait:
      nsExec::ExecToStack '"$SYSDIR\cmd.exe" /D /S /C ""$SYSDIR\tasklist.exe" /NH | "$SYSDIR\findstr.exe" /I /C:"deep-student.exe" /C:"Deep Student.exe""'
      Pop $R2
      Pop $R4
      ${If} $R2 == 1
        Goto ds_update_stopped
      ${EndIf}
      ${If} $R3 >= 30
        nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM deep-student.exe /T'
        Pop $R2
        nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "Deep Student.exe" /T'
        Pop $R2
        Goto ds_update_stopped
      ${EndIf}
      Sleep 500
      IntOp $R3 $R3 + 1
      Goto ds_update_wait
    ds_update_stopped:

    ; 优先调用 Tauri 自带卸载器（HKCU 与 HKLM 均清理），避免旧文件、快捷方式与卸载项残留。
    !insertmacro _dsFindTauriUninstaller HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Deep Student" "$LOCALAPPDATA\Deep Student\uninstall.exe" $R7
    ${If} $R7 == ""
      !insertmacro _dsFindTauriUninstaller HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\deep-student" "$LOCALAPPDATA\deep-student\uninstall.exe" $R7
    ${EndIf}
    !insertmacro _dsRunTauriUninstaller $R7
    !insertmacro _dsRunTauriUninstaller $R6
  ${EndIf}
!macroend

!macro customInstall
  ; assisted 安装器只在 `--force-run`（/R）时由 installSection 自动启动应用；
  ; 旧版 Tauri updater 只传 `/P /UPDATE`（不带 `/R`），此时需要主动拉起新的 Electron 版本，
  ; 且当安装器曾提权卸载 HKLM 旧版时，必须以标准用户权限启动，避免高权限污染桌面会话与 DPAPI。
  ${GetParameters} $R0
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    ${IfNot} ${isForceRun}
      ${If} ${UAC_IsInnerInstance}
      ${OrIf} ${UAC_IsAdmin}
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
      ${Else}
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
