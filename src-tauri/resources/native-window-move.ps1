$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class RefCanvasNativeWindowMove
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int VK_LBUTTON = 0x01;
    private const int VK_RBUTTON = 0x02;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;
    private const int VK_SPACE = 0x20;
    private const int VK_ADD = 0x6B;
    private const int VK_SUBTRACT = 0x6D;
    private const int VK_OEM_PLUS = 0xBB;
    private const int VK_OEM_MINUS = 0xBD;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_MOUSEHWHEEL = 0x020E;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const int DWMWA_NCRENDERING_POLICY = 2;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMNCRP_DISABLED = 1;
    private const int DWMWCP_DONOTROUND = 1;
    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    private const int INPUT_NONE = 0;
    private const int INPUT_PICK = 1;
    private const int INPUT_PAN = 2;
    private const int INPUT_BLOCK = 3;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseHookData
    {
        public Point Position;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardHookData
    {
        public uint VirtualKey;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Value;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Position;
        public uint Private;
    }

    private delegate IntPtr MouseHookProc(int code, IntPtr wParam, IntPtr lParam);
    private delegate IntPtr KeyboardHookProc(int code, IntPtr wParam, IntPtr lParam);

    private static readonly object OutputLock = new object();
    private static readonly object HookLock = new object();
    private static readonly ManualResetEventSlim HookStarted = new ManualResetEventSlim(false);
    private static Thread hookThread;
    private static MouseHookProc hookProcedure;
    private static KeyboardHookProc keyboardHookProcedure;
    private static IntPtr hookHandle = IntPtr.Zero;
    private static IntPtr keyboardHookHandle = IntPtr.Zero;
    private static int hookPhysicalCoordinatesReady;
    private static int hookThreadId;
    private static long inputWindowHandle;
    private static int inputEnabled;
    private static int collaborationZoomEnabled;
    private static int inputMode;
    private static int inputStartedAt;
    private const uint WM_QUIT = 0x0012;

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWindowsHookEx(int hookId, MouseHookProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWindowsHookEx(int hookId, KeyboardHookProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(int threadId, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern int GetCurrentThreadId();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;

    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int valueSize);

    public static bool Begin(long rawHandle)
    {
        // Cursor and window bounds must use the same physical coordinate space.
        // The PowerShell host is DPI-virtualized on scaled displays.
        if (SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == IntPtr.Zero)
            return false;
        if ((GetAsyncKeyState(VK_RBUTTON) & 0x8000) == 0)
            return false;

        var window = new IntPtr(rawHandle);
        Point startCursor;
        Rect startBounds;
        if (!GetCursorPos(out startCursor) || !GetWindowRect(window, out startBounds))
            return false;

        var lastX = startBounds.Left;
        var lastY = startBounds.Top;
        var moved = false;
        while ((GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0)
        {
            Point cursor;
            if (!GetCursorPos(out cursor)) break;
            var nextX = startBounds.Left + cursor.X - startCursor.X;
            var nextY = startBounds.Top + cursor.Y - startCursor.Y;
            if (nextX == lastX && nextY == lastY)
            {
                Thread.Sleep(1);
                continue;
            }
            if (SetWindowPos(window, IntPtr.Zero, nextX, nextY, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE))
            {
                lastX = nextX;
                lastY = nextY;
                moved = true;
                DwmFlush();
            }
        }
        return moved;
    }

    public static bool IsKeyDown(int virtualKey)
    {
        return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
    }

    public static bool SetFlatAppearance(long rawHandle)
    {
        var window = new IntPtr(rawHandle);
        if (window == IntPtr.Zero) return false;
        var renderingPolicy = DWMNCRP_DISABLED;
        var cornerPreference = DWMWCP_DONOTROUND;
        var renderingResult = DwmSetWindowAttribute(window, DWMWA_NCRENDERING_POLICY,
            ref renderingPolicy, sizeof(int));
        var cornerResult = DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE,
            ref cornerPreference, sizeof(int));
        return renderingResult >= 0 && cornerResult >= 0;
    }

    private static void Emit(string line)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static bool PointInsideWindow(IntPtr window, Point point)
    {
        // Destroyed HWNDs can be reused by unrelated windows. Never treat a
        // stale handle as "inside" or the LL hook will swallow system clicks.
        if (window == IntPtr.Zero || !IsWindow(window)) return false;
        Rect bounds;
        return GetWindowRect(window, out bounds)
            && point.X >= bounds.Left && point.X < bounds.Right
            && point.Y >= bounds.Top && point.Y < bounds.Bottom;
    }

    private static string PointerType(MouseHookData data)
    {
        var extra = data.ExtraInfo.ToInt64();
        return (extra & 0xFFFFFF00L) == 0xFF515700L ? "pen" : "mouse";
    }

    private static void EmitPointer(string kind, MouseHookData data, bool alt, bool space, int delta)
    {
        Emit("POINTER|" + kind + "|" + data.Position.X + "|" + data.Position.Y
            + "|" + (alt ? "1" : "0") + "|" + (space ? "1" : "0")
            + "|" + PointerType(data) + "|" + delta);
    }

    private static void SetInputMode(int mode)
    {
        Interlocked.Exchange(ref inputMode, mode);
        Interlocked.Exchange(ref inputStartedAt, mode == INPUT_NONE ? 0 : Environment.TickCount);
    }

    private static IntPtr InputHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0 || Volatile.Read(ref inputEnabled) == 0)
            return CallNextHookEx(hookHandle, code, wParam, lParam);

        var data = (MouseHookData)Marshal.PtrToStructure(lParam, typeof(MouseHookData));
        var message = wParam.ToInt32();
        var physicalMouse = PointerType(data) == "mouse";
        var window = new IntPtr(Interlocked.Read(ref inputWindowHandle));
        // Stale HWND after Yoiniwa exit/HWND reuse must never eat buttons.
        if (window == IntPtr.Zero || !IsWindow(window))
        {
            Volatile.Write(ref inputEnabled, 0);
            SetInputMode(INPUT_NONE);
            Interlocked.Exchange(ref inputWindowHandle, 0);
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }
        var inside = PointInsideWindow(window, data.Position);
        var alt = IsKeyDown(VK_MENU);
        var space = IsKeyDown(VK_SPACE);
        var mode = Volatile.Read(ref inputMode);
        if (message == WM_LBUTTONDOWN && alt)
            Emit("INPUT_PROBE|DOWN|" + data.Position.X + "|" + data.Position.Y
                + "|" + (inside ? "1" : "0") + "|" + PointerType(data));
        var expired = mode != INPUT_NONE
            && unchecked(Environment.TickCount - Volatile.Read(ref inputStartedAt)) > 15000;
        // Windows Ink often reports VK_LBUTTON as released while a pen tip is
        // still moving. Keep ownership through WM_MOUSEMOVE and finish only on
        // the real up/cancel/superseding contact paths below.
        var physicalReleaseMissed = mode != INPUT_NONE && message != WM_LBUTTONUP
            && message != WM_MOUSEMOVE && !IsKeyDown(VK_LBUTTON);
        var superseded = mode != INPUT_NONE && message == WM_LBUTTONDOWN;
        if (expired || physicalReleaseMissed || superseded)
        {
            if (mode == INPUT_PICK || mode == INPUT_PAN) EmitPointer("CANCEL", data, alt, space, 0);
            SetInputMode(INPUT_NONE);
            mode = INPUT_NONE;
        }

        if (message == WM_MOUSEMOVE)
        {
            if (mode == INPUT_PICK)
            {
                if (!alt)
                {
                    EmitPointer("CANCEL", data, false, space, 0);
                    SetInputMode(INPUT_BLOCK);
                }
                else EmitPointer("MOVE", data, true, space, 0);
                // A mouse reports relative motion through WM_MOUSEMOVE. If the
                // hook consumes it, the system cursor never advances and the
                // synthetic collaboration pointer appears stuck and jittery.
                // Pen input remains suppressed so Windows Ink ownership and
                // Photoshop's next real tip contact keep their existing path.
                return physicalMouse ? CallNextHookEx(hookHandle, code, wParam, lParam) : new IntPtr(1);
            }
            if (mode == INPUT_PAN)
            {
                EmitPointer("MOVE", data, alt, space, 0);
                return physicalMouse ? CallNextHookEx(hookHandle, code, wParam, lParam) : new IntPtr(1);
            }
            if (mode == INPUT_BLOCK) return CallNextHookEx(hookHandle, code, wParam, lParam);
            if (inside && alt && !IsKeyDown(VK_LBUTTON)) EmitPointer("HOVER", data, true, space, 0);
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        if (message == WM_LBUTTONDOWN && inside)
        {
            if (alt)
            {
                SetInputMode(INPUT_PICK);
                EmitPointer("DOWN", data, true, space, 0);
            }
            else if (space)
            {
                SetInputMode(INPUT_PAN);
                EmitPointer("DOWN", data, false, true, 0);
            }
            else if (!physicalMouse)
            {
                // Pen tip over Yoiniwa: track block mode for MOVE suppress only.
                // Never eat DOWN/UP — a leaked swallow bricks desktop LBUTTON.
                SetInputMode(INPUT_BLOCK);
            }
            // ALWAYS pass buttons through. Collaboration uses ignore_cursor +
            // POINTER emits; swallowing LBUTTON is what left the OS stuck.
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        if (message == WM_LBUTTONUP && mode != INPUT_NONE)
        {
            if (mode == INPUT_PICK)
                EmitPointer(alt ? "UP" : "CANCEL", data, alt, space, 0);
            else if (mode == INPUT_PAN) EmitPointer("UP", data, alt, space, 0);
            SetInputMode(INPUT_NONE);
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        // Never swallow right button either (same stuck-button failure mode).
        if (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP)
            return CallNextHookEx(hookHandle, code, wParam, lParam);

        if ((message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) && inside)
        {
            var delta = unchecked((short)((data.MouseData >> 16) & 0xFFFF));
            EmitPointer(message == WM_MOUSEHWHEEL ? "HWHEEL" : "WHEEL", data, alt, space, delta);
            // Never swallow wheel — emit only. Swallowing is unnecessary with click-through.
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        return CallNextHookEx(hookHandle, code, wParam, lParam);
    }

    private static IntPtr KeyboardInputHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0 || Volatile.Read(ref inputEnabled) == 0
            || Volatile.Read(ref collaborationZoomEnabled) == 0
            || Volatile.Read(ref inputMode) != INPUT_NONE)
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);

        var message = wParam.ToInt32();
        if (message != WM_KEYDOWN && message != WM_SYSKEYDOWN)
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);

        var data = (KeyboardHookData)Marshal.PtrToStructure(lParam, typeof(KeyboardHookData));
        var zoomIn = data.VirtualKey == VK_ADD || data.VirtualKey == VK_OEM_PLUS;
        var zoomOut = data.VirtualKey == VK_SUBTRACT || data.VirtualKey == VK_OEM_MINUS;
        if ((!zoomIn && !zoomOut) || !IsKeyDown(VK_CONTROL) || IsKeyDown(VK_MENU))
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);

        Point cursor;
        var window = new IntPtr(Interlocked.Read(ref inputWindowHandle));
        if (!GetCursorPos(out cursor) || !PointInsideWindow(window, cursor))
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);

        Emit("ZOOM|" + (zoomIn ? "IN" : "OUT") + "|" + cursor.X + "|" + cursor.Y);
        return new IntPtr(1);
    }

    private static void InputHookLoop()
    {
        // MSLLHOOKSTRUCT coordinates are per-monitor-aware physical pixels.
        // Without matching this thread's DPI context, GetWindowRect returns
        // virtualized bounds and the taskbar overlap is mistaken for outside.
        var physicalCoordinates = SetThreadDpiAwarenessContext(
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != IntPtr.Zero;
        Volatile.Write(ref hookPhysicalCoordinatesReady, physicalCoordinates ? 1 : 0);
        hookProcedure = InputHook;
        keyboardHookProcedure = KeyboardInputHook;
        Volatile.Write(ref hookThreadId, GetCurrentThreadId());
        hookHandle = physicalCoordinates
            ? SetWindowsHookEx(WH_MOUSE_LL, hookProcedure, GetModuleHandle(null), 0)
            : IntPtr.Zero;
        keyboardHookHandle = physicalCoordinates
            ? SetWindowsHookEx(WH_KEYBOARD_LL, keyboardHookProcedure, GetModuleHandle(null), 0)
            : IntPtr.Zero;
        HookStarted.Set();
        if (hookHandle == IntPtr.Zero)
        {
            Volatile.Write(ref hookThreadId, 0);
            return;
        }
        try
        {
            Message message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        finally
        {
            UninstallHooks();
            Volatile.Write(ref hookThreadId, 0);
        }
    }

    private static void UninstallHooks()
    {
        lock (HookLock)
        {
            if (hookHandle != IntPtr.Zero)
            {
                UnhookWindowsHookEx(hookHandle);
                hookHandle = IntPtr.Zero;
            }
            if (keyboardHookHandle != IntPtr.Zero)
            {
                UnhookWindowsHookEx(keyboardHookHandle);
                keyboardHookHandle = IntPtr.Zero;
            }
        }
    }

    private static void ReleaseStuckButtons()
    {
        // If a prior hook ate LEFTDOWN and died before UP, the desktop can keep
        // a stuck press. Force-up is exit-only recovery (not used during pick).
        try
        {
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
        }
        catch { }
    }

    // Must run before the helper process dies. Killing PowerShell while WH_MOUSE_LL
    // is installed can leave LBUTTON swallowed (especially after HWND reuse).
    public static void ShutdownInputHooks()
    {
        Volatile.Write(ref inputEnabled, 0);
        Interlocked.Exchange(ref inputWindowHandle, 0);
        SetInputMode(INPUT_NONE);
        // Quit the hook thread first so Unhook runs on the installing thread
        // (InputHookLoop finally). Unhooking from stdin then killing races.
        var threadId = Volatile.Read(ref hookThreadId);
        if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        lock (HookLock)
        {
            var thread = hookThread;
            hookThread = null;
            if (thread != null && thread.IsAlive)
            {
                if (!thread.Join(1500))
                {
                    try { thread.Interrupt(); } catch { }
                }
            }
        }
        UninstallHooks();
        ReleaseStuckButtons();
        Volatile.Write(ref hookPhysicalCoordinatesReady, 0);
        HookStarted.Reset();
        try { Emit("INPUT_SHUTDOWN"); } catch { }
    }

    public static bool ConfigureInput(long rawHandle, bool enabled, bool enableCollaborationZoom)
    {
        if (!enabled)
        {
            ShutdownInputHooks();
            return true;
        }
        lock (HookLock)
        {
            if (hookThread == null || !hookThread.IsAlive)
            {
                HookStarted.Reset();
                hookThread = new Thread(InputHookLoop);
                hookThread.IsBackground = true;
                hookThread.Name = "Yoiniwa collaboration input";
                hookThread.Start();
            }
        }
        if (!HookStarted.Wait(1500) || hookHandle == IntPtr.Zero
            || Volatile.Read(ref hookPhysicalCoordinatesReady) == 0) return false;
        var alreadyConfigured = Volatile.Read(ref inputEnabled) != 0
            && Interlocked.Read(ref inputWindowHandle) == rawHandle
            && Volatile.Read(ref collaborationZoomEnabled) == (enableCollaborationZoom ? 1 : 0);
        if (alreadyConfigured) return true;
        SetInputMode(INPUT_NONE);
        Interlocked.Exchange(ref inputWindowHandle, rawHandle);
        Volatile.Write(ref collaborationZoomEnabled, enableCollaborationZoom ? 1 : 0);
        Volatile.Write(ref inputEnabled, 1);
        return true;
    }

}
'@

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

try {
    AppDomain.CurrentDomain.add_ProcessExit({
        try { [RefCanvasNativeWindowMove]::ShutdownInputHooks() } catch { }
    })
} catch { }

try {
while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $parts = $line.Split('|')
        if ($parts[0] -eq 'SHUTDOWN') {
            [RefCanvasNativeWindowMove]::ShutdownInputHooks()
            [Console]::Out.WriteLine('SHUTDOWN_ACK')
            [Console]::Out.Flush()
            break
        } elseif (($parts.Length -eq 4 -or $parts.Length -eq 5) -and $parts[0] -eq 'INPUT') {
            $enabled = $parts[3] -eq '1'
            $enableCollaborationZoom = $parts.Length -eq 5 -and $parts[4] -eq '1'
            $applied = [RefCanvasNativeWindowMove]::ConfigureInput([long]::Parse($parts[2]), $enabled, $enableCollaborationZoom)
            [Console]::Out.WriteLine('INPUT_ACK|' + $parts[1] + '|' + $(if ($applied) { 'READY' } else { 'FAILED' }))
        } elseif ($parts.Length -eq 3 -and $parts[0] -eq 'KEY') {
            $down = [RefCanvasNativeWindowMove]::IsKeyDown([int]::Parse($parts[2]))
            [Console]::Out.WriteLine($parts[0] + '|' + $parts[1] + '|' + $(if ($down) { '1' } else { '0' }))
        } elseif ($parts.Length -eq 2 -and $parts[0] -eq 'APPEARANCE') {
            $applied = [RefCanvasNativeWindowMove]::SetFlatAppearance([long]::Parse($parts[1]))
            [Console]::Out.WriteLine($(if ($applied) { 'APPEARANCE_DONE' } else { 'APPEARANCE_SKIPPED' }))
        } else {
            $handle = [long]::Parse($line)
            $moved = [RefCanvasNativeWindowMove]::Begin($handle)
            [Console]::Out.WriteLine($(if ($moved) { 'DONE' } else { 'SKIPPED' }))
        }
    } catch {
        [Console]::Out.WriteLine("ERROR $($_.Exception.Message)")
    }
    [Console]::Out.Flush()
}
} finally {
    try { [RefCanvasNativeWindowMove]::ShutdownInputHooks() } catch { }
}
