; Custom NSIS hooks injected into Tauri's installer/uninstaller template
; (referenced from tauri.conf.json → bundle.windows.nsis.installerHooks).
;
; Force-kill every running instance of the app BEFORE touching its files.
; Required on Windows Terminal Server / RDS: the app autostarts and hides to the
; tray in EVERY user session, and it intercepts the window close (hides instead
; of quitting) — so Tauri's graceful "close the app" prompt is ignored and the
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
