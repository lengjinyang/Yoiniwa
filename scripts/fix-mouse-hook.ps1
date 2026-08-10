# Emergency recovery: collaboration LL mouse hook left system LBUTTON broken.
# Run this if left-click still fails after closing Yoiniwa.

Get-CimInstance Win32_Process -Filter "name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*native-window-move.ps1*' } |
  ForEach-Object {
    Write-Host "Stopping helper PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Get-Process -Name 'yoiniwa','Yoiniwa' -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "Stopping app PID $($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }

# Force-release stuck button state left by a swallowed DOWN without UP.
Add-Type -Namespace YoiniwaFix -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);
'@ -ErrorAction SilentlyContinue
try {
  [YoiniwaFix.Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) # LEFTUP
  [YoiniwaFix.Mouse]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero) # RIGHTUP
  Write-Host "Sent LEFTUP/RIGHTUP to clear stuck button state."
} catch {
  Write-Host "Could not synthesize button-up: $($_.Exception.Message)"
}

Write-Host "Done. Click once to confirm. If still stuck, sign out of Windows."
