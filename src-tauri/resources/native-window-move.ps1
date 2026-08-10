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
    private const uint LLMHF_INJECTED = 0x00000001;
    private const int IMDT_PEN = 0x08;
    private const int IMDT_TOUCH = 0x04;
    private const uint WM_QUIT = 0x0012;

    [StructLayout(LayoutKind.Sequential)]
    private struct InputMessageSource
    {
        public uint DeviceType;
        public uint OriginId;
    }

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern bool GetCurrentInputMessageSource(out InputMessageSource source);

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

    private static bool IsDigitizer(MouseHookData data)
    {
        InputMessageSource source;
        if (GetCurrentInputMessageSource(out source)
            && (source.DeviceType == IMDT_PEN || source.DeviceType == IMDT_TOUCH))
            return true;
        var extra = data.ExtraInfo.ToInt64();
        // MI_WP_SIGNATURE and nearby Wacom Ink signatures.
        if ((extra & 0xFFFFFF00L) == 0xFF515700L) return true;
        if ((extra & 0xFFFFFF00L) == 0xFF515600L) return true;
        if ((data.Flags & LLMHF_INJECTED) != 0) return true;
        return false;
    }

    private static string PointerType(MouseHookData data)
    {
        return IsDigitizer(data) ? "pen" : "mouse";
    }

    private static void EmitPointer(string kind, MouseHookData data, bool alt, bool space, int delta)
    {
        Emit("POINTER|" + kind + "|" + data.Position.X + "|" + data.Position.Y
            + "|" + (alt ? "1" : "0") + "|" + (space ? "1" : "0")
            + "|" + PointerType(data) + "|" + delta);
    }

    // Pen-overlay path drives gesture mode because LL hook Alt sampling may miss
    // the start of a Windows Ink contact. It must not alter cursor coordinates.
    public static void SetGestureMode(string mode)
    {
        if (string.Equals(mode, "pick", StringComparison.OrdinalIgnoreCase))
        {
            SetInputMode(INPUT_PICK);
            return;
        }
        if (string.Equals(mode, "pan", StringComparison.OrdinalIgnoreCase))
        {
            SetInputMode(INPUT_PAN);
            return;
        }
        if (string.Equals(mode, "block", StringComparison.OrdinalIgnoreCase))
        {
            SetInputMode(INPUT_BLOCK);
            return;
        }
        SetInputMode(INPUT_NONE);
    }

    private static void SetInputMode(int mode)
    {
        var previous = Interlocked.Exchange(ref inputMode, mode);
        Interlocked.Exchange(ref inputStartedAt, mode == INPUT_NONE ? 0 : Environment.TickCount);
        if ((mode == INPUT_NONE || mode == INPUT_BLOCK)
            && (previous == INPUT_PICK || previous == INPUT_PAN))
        {
            Emit("PICK_CRITICAL|HOLD");
            return;
        }
        if (mode == INPUT_PICK || mode == INPUT_PAN)
        {
            Emit("PICK_CRITICAL|ARM");
        }
    }

    // Observe and mirror collaboration gestures without suppressing physical pen
    // packets. Dropping MOVE/DOWN/UP leaves the absolute tablet cursor stale, so
    // Windows catches it up on pen-up or the first Photoshop tip-down.
    private static IntPtr InputHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0 || Volatile.Read(ref inputEnabled) == 0)
            return CallNextHookEx(hookHandle, code, wParam, lParam);

        var data = (MouseHookData)Marshal.PtrToStructure(lParam, typeof(MouseHookData));
        var message = wParam.ToInt32();
        var window = new IntPtr(Interlocked.Read(ref inputWindowHandle));
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
        if (message == WM_LBUTTONDOWN)
            Emit("INPUT_PROBE|DOWN|" + data.Position.X + "|" + data.Position.Y
                + "|" + (inside ? "1" : "0") + "|" + PointerType(data) + "|" + mode);
        var expired = mode != INPUT_NONE
            && unchecked(Environment.TickCount - Volatile.Read(ref inputStartedAt)) > 15000;
        var physicalReleaseMissed = mode != INPUT_NONE && message != WM_LBUTTONUP
            && message != WM_MOUSEMOVE && !IsKeyDown(VK_LBUTTON);
        // Inside tip-down is often the same contact that GESTURE already armed.
        var superseded = mode != INPUT_NONE && message == WM_LBUTTONDOWN && !inside;
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
                // Do not cancel overlay-driven pick on a missed Alt sample.
                EmitPointer("MOVE", data, true, space, 0);
                return CallNextHookEx(hookHandle, code, wParam, lParam);
            }
            if (mode == INPUT_PAN)
            {
                EmitPointer("MOVE", data, alt, space, 0);
                return CallNextHookEx(hookHandle, code, wParam, lParam);
            }
            if (mode == INPUT_BLOCK) return CallNextHookEx(hookHandle, code, wParam, lParam);
            if (inside && alt && !IsKeyDown(VK_LBUTTON)) EmitPointer("HOVER", data, true, space, 0);
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        if (message == WM_LBUTTONDOWN && inside)
        {
            if (alt || mode == INPUT_PICK)
            {
                SetInputMode(INPUT_PICK);
                EmitPointer("DOWN", data, true, space, 0);
            }
            else if (space || mode == INPUT_PAN)
            {
                SetInputMode(INPUT_PAN);
                EmitPointer("DOWN", data, false, true, 0);
            }
            else SetInputMode(INPUT_BLOCK);
            // Never consume a real contact boundary. The no-activate pen overlay
            // remains the target while Photoshop keeps foreground/Ink ownership.
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        if (message == WM_LBUTTONUP && mode != INPUT_NONE)
        {
            if (mode == INPUT_PICK)
                EmitPointer("UP", data, true, space, 0);
            else if (mode == INPUT_PAN) EmitPointer("UP", data, alt, space, 0);
            SetInputMode(INPUT_NONE);
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        if (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP)
            return CallNextHookEx(hookHandle, code, wParam, lParam);

        if ((message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) && inside)
        {
            var delta = unchecked((short)((data.MouseData >> 16) & 0xFFFF));
            EmitPointer(message == WM_MOUSEHWHEEL ? "HWHEEL" : "WHEEL", data, alt, space, delta);
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
        // Process-exit recovery only. Normal collab disable never swallows buttons,
        // and mouse_event here made exit feel like a stuck cursor hitch.
        try
        {
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
        }
        catch { }
    }

    // Must run before the helper process dies. Killing PowerShell while WH_MOUSE_LL
    // is installed can leave LBUTTON swallowed (especially after HWND reuse).
    // releaseButtons: only on process exit — never during collaboration mode toggle.
    public static void ShutdownInputHooks()
    {
        ShutdownInputHooks(false);
    }

    public static void ShutdownInputHooks(bool releaseButtons)
    {
        Volatile.Write(ref inputEnabled, 0);
        Interlocked.Exchange(ref inputWindowHandle, 0);
        SetInputMode(INPUT_NONE);
        // Quit the hook thread first so Unhook runs on the installing thread
        // (InputHookLoop finally). Unhooking from stdin then killing races.
        var threadId = Volatile.Read(ref hookThreadId);
        if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);

        // CRITICAL: Join OUTSIDE HookLock. Holding HookLock during Join deadlocks
        // InputHookLoop's finally → UninstallHooks, which needs the same lock.
        // That used to burn the full Join timeout (~1.5s) and freeze the mouse on exit.
        Thread thread;
        lock (HookLock)
        {
            thread = hookThread;
            hookThread = null;
        }
        if (thread != null && thread.IsAlive)
        {
            if (!thread.Join(300))
            {
                try { thread.Interrupt(); } catch { }
                UninstallHooks();
            }
        }
        else
        {
            UninstallHooks();
        }
        if (releaseButtons) ReleaseStuckButtons();
        Volatile.Write(ref hookPhysicalCoordinatesReady, 0);
        HookStarted.Reset();
        try { Emit("INPUT_SHUTDOWN"); } catch { }
    }

    public static bool ConfigureInput(long rawHandle, bool enabled, bool enableCollaborationZoom)
    {
        if (!enabled)
        {
            // Idempotent fast path: shortcut exit + set_mode both disable once.
            var alive = false;
            lock (HookLock) { alive = hookThread != null && hookThread.IsAlive; }
            if (Volatile.Read(ref inputEnabled) == 0 && !alive && hookHandle == IntPtr.Zero)
                return true;
            ShutdownInputHooks(false);
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
        try { [RefCanvasNativeWindowMove]::ShutdownInputHooks($true) } catch { }
    })
} catch { }

try {
while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $parts = $line.Split('|')
        if ($parts[0] -eq 'SHUTDOWN') {
            [RefCanvasNativeWindowMove]::ShutdownInputHooks($true)
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
        } elseif ($parts.Length -eq 2 -and $parts[0] -eq 'GESTURE') {
            [RefCanvasNativeWindowMove]::SetGestureMode($parts[1])
            [Console]::Out.WriteLine('GESTURE_ACK|' + $parts[1])
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
    try { [RefCanvasNativeWindowMove]::ShutdownInputHooks($true) } catch { }
}
