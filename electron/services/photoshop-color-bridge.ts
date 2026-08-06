import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type PhotoshopBridgeStatus = 'synced' | 'not-running' | 'automation-error';
type PhotoshopBridgeFocusStatus = 'activated' | 'not-found' | 'automation-error' | 'skipped';

export interface PhotoshopBridgeResult {
  syncStatus: PhotoshopBridgeStatus;
  focusStatus: PhotoshopBridgeFocusStatus;
}

const colorBridgeScript = String.raw`
$ErrorActionPreference = 'Stop'
$photoshop = $null
$color = $null
$rgb = $null
$directColor = $true
function Reset-Photoshop {
  $script:photoshop = $null; $script:color = $null; $script:rgb = $null; $script:directColor = $true
}
function Ensure-Photoshop {
  if ($null -ne $photoshop) { return $true }
  try {
    $script:photoshop = [Runtime.InteropServices.Marshal]::GetActiveObject('Photoshop.Application')
    $script:color = $photoshop.ForegroundColor
    $script:rgb = $color.RGB
    $script:directColor = $true
    return $true
  } catch { Reset-Photoshop; return $false }
}
function Color-Matches([int]$r, [int]$g, [int]$b) {
  try {
    $current = $photoshop.ForegroundColor.RGB
    return ([Math]::Abs([double]$current.Red - $r) -lt 0.75 -and [Math]::Abs([double]$current.Green - $g) -lt 0.75 -and [Math]::Abs([double]$current.Blue - $b) -lt 0.75)
  } catch { return $false }
}
function Set-PhotoshopColor([int]$r, [int]$g, [int]$b) {
  try {
    if ($directColor) {
      try {
        $rgb.Red = $r; $rgb.Green = $g; $rgb.Blue = $b
        $color.RGB = $rgb
        $photoshop.ForegroundColor = $color
        if (Color-Matches $r $g $b) { return 'SYNCED' }
      } catch {}
      $script:directColor = $false
    }
    $jsx = 'var c=new SolidColor();c.rgb.red=' + $r + ';c.rgb.green=' + $g + ';c.rgb.blue=' + $b + ';app.foregroundColor=c;'
    $null = $photoshop.DoJavaScript($jsx)
    if (Color-Matches $r $g $b) { return 'SYNCED' }
    return 'SYNC_ERROR'
  } catch { Reset-Photoshop; return 'SYNC_ERROR' }
}
$null = Ensure-Photoshop
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $parts = $line.Split('|')
  if ($parts.Length -lt 2) { continue }
  $kind = $parts[0]; $id = $parts[1]
  try {
    if (-not (Ensure-Photoshop)) {
      [Console]::Out.WriteLine($id + '|NOT_RUNNING|SKIPPED'); [Console]::Out.Flush(); continue
    }
    if ($kind -eq 'W') {
      [Console]::Out.WriteLine($id + '|SYNCED|SKIPPED'); [Console]::Out.Flush(); continue
    }
    if ($kind -ne 'S' -or $parts.Length -ne 5) { continue }
    $syncStatus = Set-PhotoshopColor ([int]$parts[2]) ([int]$parts[3]) ([int]$parts[4])
    [Console]::Out.WriteLine($id + '|' + $syncStatus + '|SKIPPED'); [Console]::Out.Flush()
  } catch {
    Reset-Photoshop
    [Console]::Out.WriteLine($id + '|SYNC_ERROR|SKIPPED'); [Console]::Out.Flush()
  }
}
`;

const focusBridgeScript = String.raw`
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
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int virtualKey);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool enable);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

  public static bool IsForeground(IntPtr hWnd) {
    return hWnd != IntPtr.Zero && GetForegroundWindow() == hWnd;
  }

  public static bool IsAltDown() {
    return (GetAsyncKeyState(0x12) & 0x8000) != 0;
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

  public static bool ReleaseAlt(IntPtr hWnd) {
    const uint WM_KEYUP = 0x0101;
    const uint WM_SYSKEYUP = 0x0105;
    const uint SMTO_ABORTIFHUNG = 0x0002;
    var altKey = new IntPtr(0x12);
    var keyUp = new IntPtr(unchecked((long)0xC0380001));
    IntPtr ignored;
    var systemReleased = SendMessageTimeout(
      hWnd, WM_SYSKEYUP, altKey, keyUp, SMTO_ABORTIFHUNG, 60, out ignored) != IntPtr.Zero;
    var keyReleased = SendMessageTimeout(
      hWnd, WM_KEYUP, altKey, keyUp, SMTO_ABORTIFHUNG, 60, out ignored) != IntPtr.Zero;
    return systemReleased || keyReleased;
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
function Release-PhotoshopAlt {
  if (-not (Ensure-PhotoshopWindow)) { return 'NOT_FOUND' }
  try {
    # The artist normally releases Alt just after focus returns. Wait briefly
    # for that physical release, then complete both key-up message paths. This
    # closes the rare gap where Windows routes the real key-up during the focus
    # transition and Photoshop treats the following pen-down as still modified.
    for ($wait = 0; $wait -lt 36 -and [YoiniwaWindowActivation]::IsAltDown(); $wait += 1) {
      Start-Sleep -Milliseconds 5
    }
    if ([YoiniwaWindowActivation]::IsAltDown()) { return 'SKIPPED' }
    # Complete both Alt key-up message paths before Photoshop is declared
    # input-ready. This never moves the pointer or synthesizes mouse input.
    $released = [YoiniwaWindowActivation]::ReleaseAlt($photoshopWindow)
    if ($photoshopFocus -ne [IntPtr]::Zero -and $photoshopFocus -ne $photoshopWindow) {
      $released = [YoiniwaWindowActivation]::ReleaseAlt($photoshopFocus) -or $released
    }
    if ($released) { return 'SKIPPED' }
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
    } elseif ($kind -eq 'K') { $status = Release-PhotoshopAlt
    } else { continue }
    [Console]::Out.WriteLine($id + '|SYNCED|' + $status); [Console]::Out.Flush()
  } catch {
    Reset-PhotoshopWindow
    [Console]::Out.WriteLine($id + '|SYNCED|FOCUS_ERROR'); [Console]::Out.Flush()
  }
}
`;

interface PendingRequest {
  resolve(result: PhotoshopBridgeResult): void;
  timer: NodeJS.Timeout;
  fallback: PhotoshopBridgeResult;
}

const SYNC_ERROR_RESULT: PhotoshopBridgeResult = { syncStatus: 'automation-error', focusStatus: 'skipped' };
const FOCUS_ERROR_RESULT: PhotoshopBridgeResult = { syncStatus: 'synced', focusStatus: 'automation-error' };

interface PhotoshopCommitOperations {
  sync(): Promise<PhotoshopBridgeResult>;
  focus(): Promise<PhotoshopBridgeResult>;
  releaseAlt(): Promise<PhotoshopBridgeResult>;
}

export async function runPhotoshopCommitSequence(
  activatePhotoshop: boolean,
  operations: PhotoshopCommitOperations,
  settleAlt = false,
): Promise<PhotoshopBridgeResult> {
  let sync = await operations.sync();
  if (sync.syncStatus === 'automation-error') sync = await operations.sync();
  const focus = activatePhotoshop
    ? await operations.focus()
    : { syncStatus: 'synced', focusStatus: 'skipped' } as PhotoshopBridgeResult;
  // In non-activating reference mode Photoshop intentionally stays in the
  // foreground. It still needs its Alt key state reconciled after Yoiniwa
  // consumed the pen gesture, otherwise the next pen-down can be discarded.
  if (focus.focusStatus === 'activated' || settleAlt) await operations.releaseAlt();
  return { syncStatus: sync.syncStatus, focusStatus: focus.focusStatus };
}

export function parsePhotoshopBridgeResponse(line: string): { id: string; result: PhotoshopBridgeResult } | undefined {
  const [id, rawSync, rawFocus] = line.trim().split('|');
  if (!id || !rawSync || !rawFocus) return undefined;
  const syncStatus: PhotoshopBridgeStatus = rawSync === 'SYNCED'
    ? 'synced' : rawSync === 'NOT_RUNNING' ? 'not-running' : 'automation-error';
  const focusStatus: PhotoshopBridgeFocusStatus = rawFocus === 'ACTIVATED'
    ? 'activated' : rawFocus === 'NOT_FOUND'
      ? 'not-found' : rawFocus === 'SKIPPED' ? 'skipped' : 'automation-error';
  return { id, result: { syncStatus, focusStatus } };
}

class PhotoshopHelperProcess {
  private process?: ChildProcessWithoutNullStreams;
  private output = '';
  private requestId = 0;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly script: string) {}

  start() {
    if (this.process || process.platform !== 'win32') return;
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', this.script,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.resume();
    const terminate = () => { if (this.process === child) this.stop(); };
    child.on('error', terminate);
    child.on('exit', terminate);
  }

  stop() {
    const child = this.process;
    this.process = undefined;
    if (child && !child.killed) child.kill();
    this.pending.forEach((request) => {
      clearTimeout(request.timer);
      request.resolve(request.fallback);
    });
    this.pending.clear(); this.output = '';
  }

  send(kind: 'W' | 'S' | 'P' | 'F' | 'K', values: number[], timeoutMs: number, fallback: PhotoshopBridgeResult) {
    this.start();
    const child = this.process;
    if (!child?.stdin.writable) return Promise.resolve(fallback);
    const id = String(++this.requestId);
    return new Promise<PhotoshopBridgeResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.stop();
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer, fallback });
      child.stdin.write([kind, id, ...values].join('|') + '\n', (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(id); request.resolve(fallback);
      });
    });
  }

  private consume(chunk: string) {
    this.output += chunk;
    const lines = this.output.split(/\r?\n/);
    this.output = lines.pop() ?? '';
    lines.forEach((line) => {
      const response = parsePhotoshopBridgeResponse(line);
      if (!response) return;
      const request = this.pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(response.id); request.resolve(response.result);
    });
  }
}

/** Keeps Photoshop COM and its native window handle warm between color samples. */
export class PhotoshopColorBridge {
  private readonly colorHelper = new PhotoshopHelperProcess(colorBridgeScript);
  private readonly focusHelper = new PhotoshopHelperProcess(focusBridgeScript);

  start() { this.colorHelper.start(); this.focusHelper.start(); }

  async warm(timeoutMs = 3000): Promise<PhotoshopBridgeResult> {
    const [sync, focus] = await Promise.all([
      this.colorHelper.send('W', [], timeoutMs, SYNC_ERROR_RESULT),
      this.focusHelper.send('W', [], timeoutMs, FOCUS_ERROR_RESULT),
    ]);
    return { syncStatus: sync.syncStatus, focusStatus: focus.focusStatus };
  }

  captureFocus(timeoutMs = 150) {
    return this.focusHelper.send('P', [], timeoutMs, FOCUS_ERROR_RESULT);
  }

  activate(timeoutMs = 800) {
    return this.focusHelper.send('F', [], timeoutMs, FOCUS_ERROR_RESULT);
  }

  async commit(
    color: { r: number; g: number; b: number },
    activatePhotoshop: boolean,
    settleAlt = false,
    timeoutMs = 1800,
  ) {
    // Photoshop's COM automation runs on its UI thread. Returning focus while
    // that write is still in flight makes an immediate pen-down get consumed
    // by the automation call. Finish (and, if needed, retry) the color write
    // first, then hand Photoshop an already-idle input queue.
    return runPhotoshopCommitSequence(activatePhotoshop, {
      sync: () => this.colorHelper.send('S', [color.r, color.g, color.b], timeoutMs, SYNC_ERROR_RESULT),
      focus: () => this.focusHelper.send('F', [], timeoutMs, FOCUS_ERROR_RESULT),
      releaseAlt: () => this.releaseAlt(),
    }, settleAlt);
  }

  releaseAlt() {
    return this.focusHelper.send('K', [], 500, FOCUS_ERROR_RESULT);
  }

  stop() { this.colorHelper.stop(); this.focusHelper.stop(); }
}
