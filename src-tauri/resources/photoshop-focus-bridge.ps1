
$ErrorActionPreference = 'Stop'
$photoshopPid = 0
$photoshopWindow = [IntPtr]::Zero
$photoshopFocus = [IntPtr]::Zero
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class YoiniwaWindowActivation {
  [StructLayout(LayoutKind.Sequential)] public struct Rect {
    public int Left; public int Top; public int Right; public int Bottom;
  }
  [StructLayout(LayoutKind.Sequential)] public struct GuiThreadInfo {
    public int Size; public uint Flags; public IntPtr Active; public IntPtr Focus;
    public IntPtr Capture; public IntPtr MenuOwner; public IntPtr MoveSize;
    public IntPtr Caret; public Rect CaretRect;
  }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool enable);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  public static bool IsForeground(IntPtr hWnd) {
    return hWnd != IntPtr.Zero && GetForegroundWindow() == hWnd;
  }

  public static IntPtr GetFocusedWindow(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return IntPtr.Zero;
    uint processId;
    var threadId = GetWindowThreadProcessId(hWnd, out processId);
    var info = new GuiThreadInfo();
    info.Size = Marshal.SizeOf(typeof(GuiThreadInfo));
    if (!GetGUIThreadInfo(threadId, ref info)) return IntPtr.Zero;
    var focused = info.Focus != IntPtr.Zero ? info.Focus : info.Active;
    if (focused == IntPtr.Zero || !IsWindow(focused)) return IntPtr.Zero;
    uint focusedProcess;
    GetWindowThreadProcessId(focused, out focusedProcess);
    return focusedProcess == processId ? focused : IntPtr.Zero;
  }

  public static bool IsInputReady(IntPtr hWnd, IntPtr focusHWnd) {
    if (!IsForeground(hWnd)) return false;
    if (focusHWnd == IntPtr.Zero || !IsWindow(focusHWnd)) return true;
    return GetFocusedWindow(hWnd) == focusHWnd;
  }

  public static bool ActivateWindow(IntPtr hWnd, IntPtr focusHWnd) {
    if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return false;
    var currentThread = GetCurrentThreadId();
    uint targetProcess;
    uint ignored;
    var foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    var targetThread = GetWindowThreadProcessId(hWnd, out targetProcess);
    uint focusProcess = 0;
    var focusThread = focusHWnd != IntPtr.Zero && IsWindow(focusHWnd)
      ? GetWindowThreadProcessId(focusHWnd, out focusProcess) : 0;
    var attachedForeground = false;
    var attachedTarget = false;
    var attachedFocus = false;
    try {
      if (foregroundThread != 0 && foregroundThread != currentThread) {
        attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      }
      if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) {
        attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      }
      if (focusThread != 0 && focusThread != currentThread && focusThread != foregroundThread && focusThread != targetThread) {
        attachedFocus = AttachThreadInput(currentThread, focusThread, true);
      }
      SetActiveWindow(hWnd);
      SetForegroundWindow(hWnd);
      if (focusThread != 0 && focusProcess == targetProcess) SetFocus(focusHWnd);
      return IsInputReady(hWnd, focusHWnd);
    } finally {
      if (attachedFocus) AttachThreadInput(currentThread, focusThread, false);
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }

}
'@
function Reset-PhotoshopWindow {
  $script:photoshopPid = 0; $script:photoshopWindow = [IntPtr]::Zero; $script:photoshopFocus = [IntPtr]::Zero
}
function Ensure-PhotoshopWindow {
  if ($photoshopWindow -ne [IntPtr]::Zero -and [YoiniwaWindowActivation]::IsWindow($photoshopWindow)) { return $true }
  Reset-PhotoshopWindow
  try {
    $photoshopProcess = Get-Process -Name Photoshop -ErrorAction Stop |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
      Select-Object -First 1
    if ($null -eq $photoshopProcess) { return $false }
    $script:photoshopPid = $photoshopProcess.Id
    $script:photoshopWindow = $photoshopProcess.MainWindowHandle
    return $true
  } catch { Reset-PhotoshopWindow; return $false }
}
function Capture-PhotoshopFocus {
  if (-not (Ensure-PhotoshopWindow)) { return 'NOT_FOUND' }
  try {
    $focused = [YoiniwaWindowActivation]::GetFocusedWindow($photoshopWindow)
    if ($focused -ne [IntPtr]::Zero) { $script:photoshopFocus = $focused }
    return 'SKIPPED'
  } catch { Reset-PhotoshopWindow; return 'FOCUS_ERROR' }
}
function Activate-Photoshop {
  if (-not (Ensure-PhotoshopWindow)) { return 'NOT_FOUND' }
  try {
    if ($photoshopFocus -ne [IntPtr]::Zero -and -not [YoiniwaWindowActivation]::IsWindow($photoshopFocus)) {
      $script:photoshopFocus = [IntPtr]::Zero
    }
    if ($photoshopFocus -eq [IntPtr]::Zero) { $null = Capture-PhotoshopFocus }
    if ([YoiniwaWindowActivation]::IsIconic($photoshopWindow)) {
      $null = [YoiniwaWindowActivation]::ShowWindowAsync($photoshopWindow, 9)
    }
    for ($attempt = 0; $attempt -lt 6; $attempt += 1) {
      if ([YoiniwaWindowActivation]::ActivateWindow($photoshopWindow, $photoshopFocus)) { return 'ACTIVATED' }
      try { $null = [Microsoft.VisualBasic.Interaction]::AppActivate($photoshopPid) } catch {}
      for ($wait = 0; $wait -lt 6; $wait += 1) {
        if ([YoiniwaWindowActivation]::ActivateWindow($photoshopWindow, $photoshopFocus)) { return 'ACTIVATED' }
        Start-Sleep -Milliseconds 5
      }
    }
    return 'FOCUS_ERROR'
  } catch { Reset-PhotoshopWindow; return 'FOCUS_ERROR' }
}
$null = Ensure-PhotoshopWindow
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $parts = $line.Split('|')
  if ($parts.Length -lt 2) { continue }
  $kind = $parts[0]; $id = $parts[1]
  try {
    if ($kind -eq 'W') {
      $status = if (Ensure-PhotoshopWindow) { 'SKIPPED' } else { 'NOT_FOUND' }
    } elseif ($kind -eq 'P') { $status = Capture-PhotoshopFocus
    } elseif ($kind -eq 'F') { $status = Activate-Photoshop
    } else { continue }
    [Console]::Out.WriteLine($id + '|SYNCED|' + $status); [Console]::Out.Flush()
  } catch {
    Reset-PhotoshopWindow
    [Console]::Out.WriteLine($id + '|SYNCED|FOCUS_ERROR'); [Console]::Out.Flush()
  }
}
