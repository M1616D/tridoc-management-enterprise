!macro customInstall
  DetailPrint "Checking for running TriDoc Enterprise process..."
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq TriDoc Enterprise.exe"'
  Pop $0
  Pop $1
  ${If} $1 != 0
    DetailPrint "Found running process. Closing it now..."
    nsExec::Exec 'taskkill /f /im "TriDoc Enterprise.exe"'
    Sleep 2000
  ${EndIf}
!macroend