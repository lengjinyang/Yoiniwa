!define YOINIWA_THUMBNAIL_HANDLER "{2B0F173D-5E7E-4C36-A901-9A9D75E2B7BF}"
!define YOINIWA_THUMBNAIL_CATEGORY "{E357FCCD-A995-4576-B01F-234630154E96}"

!macro NSIS_HOOK_POSTINSTALL
  SetRegView 64
  ExecWait '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\thumbnail-provider\YoiniwaThumbnailProvider.dll"'
  WriteRegStr HKCU "Software\Classes\.yoi\ShellEx\${YOINIWA_THUMBNAIL_CATEGORY}" "" "${YOINIWA_THUMBNAIL_HANDLER}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetRegView 64
  ExecWait '"$SYSDIR\regsvr32.exe" /s /u "$INSTDIR\thumbnail-provider\YoiniwaThumbnailProvider.dll"'
  DeleteRegKey HKCU "Software\Classes\.yoi\ShellEx\${YOINIWA_THUMBNAIL_CATEGORY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
