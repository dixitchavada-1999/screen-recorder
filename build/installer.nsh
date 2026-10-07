; ---------------------------------------------------------------------------
; Removing the browser extension's install policy on uninstall.
;
; The app puts its browser extension on Chrome's and Edge's force-install list
; (electron/main/services/browser-policy.ts) and notes which numbered entry it
; wrote under HKCU\Software\Screen Recorder\BrowserExtension. Here that one entry
; is removed — and only if it still holds what the app wrote, so an entry an
; organisation has since put at the same number is left alone.
; ---------------------------------------------------------------------------

; ---------------------------------------------------------------------------
; The uninstall password.
;
; Before anything is removed, the app's own executable is started with
; --uninstall-guard and asked for the password (electron/main/uninstall-guard.ts).
; It exits 0 only for the right one; anything else — wrong three times, Cancel,
; the window closed, the executable missing — stops the uninstaller here.
;
; Skipped only when the uninstaller is run by an update: the new installer runs
; the old uninstaller with --updated, and an update must not wait for a password
; nobody is there to type. A silent uninstall (/S) still asks.
; ---------------------------------------------------------------------------

!macro customUnInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-guard' $R2
    ${If} ${Errors}
    ${OrIf} $R2 != 0
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro RemoveForcelistEntry BROWSER POLICY_KEY
  ReadRegStr $0 HKCU "Software\Screen Recorder\BrowserExtension" "${BROWSER}Index"
  ReadRegStr $1 HKCU "Software\Screen Recorder\BrowserExtension" "${BROWSER}Entry"
  StrCmp $0 "" +4
  ReadRegStr $2 HKCU "${POLICY_KEY}" $0
  StrCmp $2 $1 0 +2
  DeleteRegValue HKCU "${POLICY_KEY}" $0
!macroend

!macro customUnInstall
  !insertmacro RemoveForcelistEntry "Chrome" "Software\Policies\Google\Chrome\ExtensionInstallForcelist"
  !insertmacro RemoveForcelistEntry "Edge" "Software\Policies\Microsoft\Edge\ExtensionInstallForcelist"
  DeleteRegKey HKCU "Software\Screen Recorder\BrowserExtension"
!macroend
