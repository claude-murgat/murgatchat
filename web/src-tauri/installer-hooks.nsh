; Custom NSIS hooks injected into Tauri's installer/uninstaller template
; (referenced from tauri.conf.json -> bundle.windows.nsis.installerHooks).
;
; ----------------------------------------------------------------------------
; 1) PRE(UN)INSTALL - force-kill every running instance BEFORE touching files.
; ----------------------------------------------------------------------------
; Required on Windows Terminal Server / RDS: the app autostarts and hides to the
; tray in EVERY user session, and it intercepts the window close (hides instead
; of quitting) - so Tauri's graceful "close the app" prompt is ignored and the
; running instances keep the installed files locked, breaking the (re)install.
;
; A per-machine install runs elevated, so `taskkill /IM` reaches ALL sessions;
; `/F` bypasses the hide-to-tray. We deliberately do NOT pass `/T`: during a
; per-user auto-update the setup can run as a child of the app process, and we
; must not kill that tree. WebView2 children exit with their host anyway and
; don't lock the app's own files.
;
; NOTE: the image name is the Cargo package name (`chat-desktop.exe`), NOT the
; productName ("Chat"). Keep in sync if `mainBinaryName` is ever set.
;
; ----------------------------------------------------------------------------
; 2) POSTINSTALL - guarantee the Start Menu shortcut points at THIS version.
; ----------------------------------------------------------------------------
; Tauri SKIPS Start-Menu shortcut (re)creation when the installer runs with
; /UPDATE (its auto-updater always passes it): see CreateOrUpdateStartMenuShortcut
; -> `${If} $UpdateMode = 1 ... Return`. It only migrates the target when an
; existing shortcut still points at an OLD *binary name*. Combined with
; installMode "both", a previous install in the OTHER context (per-user vs
; all-users) keeps its own "Chat.lnk" pointing at an OLD copy. Net effect: after
; an update some users still launch a stale version from the Start Menu.
;
; Fix: after install, (a) force a fresh shortcut in THIS install's context, then
; (b) drop any "Chat.lnk" from EITHER context that does not already target the
; binary we just installed. The IsShortcutTarget guard means the freshly created
; shortcut is always kept, so we never need to know which context is "active" -
; a wrong guess can't delete the good shortcut.
;
; Macros/vars below (IsShortcutTarget, UnpinShortcut, SetLnkAppUserModelId,
; ${PRODUCTNAME}, ${MAINBINARYNAME}, ${STARTMENUFOLDER}, ${INSTALLMODE},
; $AppStartMenuFolder, $MultiUser.InstallMode) come from Tauri's template /
; utils.nsh and are resolved when this hook is expanded into the installer.

!macro NSIS_HOOK_PREINSTALL
  Push $0
  nsExec::Exec 'cmd /c taskkill /F /IM "chat-desktop.exe"'
  Pop $0
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  nsExec::Exec 'cmd /c taskkill /F /IM "chat-desktop.exe"'
  Pop $0
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0

  ; (a) Force a correct shortcut in the context THIS install used. $SMPROGRAMS is
  ;     still the active context here (Tauri hasn't touched SetShellVarContext
  ;     since the install steps), so we create before changing context. Mirror
  ;     Tauri's own folder/bare placement so we never produce a duplicate.
  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif

  ; (b) Remove a stale "${PRODUCTNAME}.lnk" from BOTH Start-Menu contexts. The
  ;     guard keeps any shortcut already targeting the binary we just installed
  ;     (i.e. the one created above), so only stale ones are deleted.
  SetShellVarContext all
  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 <> 1
    !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}

  SetShellVarContext current
  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 <> 1
    !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}

  ; Best-effort: restore the shell context this install actually used, in case
  ; later template code depends on it. Guarded so it only compiles for the
  ; "both" mode (the only mode where $MultiUser.InstallMode is defined).
  !if "${INSTALLMODE}" == "both"
    ${If} $MultiUser.InstallMode == "AllUsers"
      SetShellVarContext all
    ${Else}
      SetShellVarContext current
    ${EndIf}
  !endif

  Pop $0
!macroend
