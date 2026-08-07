$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class RefCanvasNativeWindowMove
{
    private const int WH_MOUSE_LL = 14;
    private const int VK_LBUTTON = 0x01;
    private const int VK_RBUTTON = 0x02;
    private const int VK_MENU = 0x12;
    private const int VK_SPACE = 0x20;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_MOUSEHWHEEL = 0x020E;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const uint GW_HWNDNEXT = 2;
    private const uint MONITOR_DEFAULTTONEAREST = 2;
    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_APPWINDOW = 0x00040000L;
    private const long WS_EX_NOACTIVATE = 0x08000000L;
    private const int DWMWA_NCRENDERING_POLICY = 2;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMNCRP_DISABLED = 1;
    private const int DWMWCP_DONOTROUND = 1;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

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

    private static readonly object OutputLock = new object();
    private static readonly object HookLock = new object();
    private static readonly ManualResetEventSlim HookStarted = new ManualResetEventSlim(false);
    private static Thread hookThread;
    private static MouseHookProc hookProcedure;
    private static IntPtr hookHandle = IntPtr.Zero;
    private static long inputWindowHandle;
    private static int inputEnabled;
    private static int inputMode;
    private static int inputStartedAt;

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWindowsHookEx(int hookId, MouseHookProc callback, IntPtr module, uint threadId);

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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);

    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int valueSize);

    public static bool Begin(long rawHandle)
    {
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

    public static bool SetNoActivate(long rawHandle, bool enabled)
    {
        var window = new IntPtr(rawHandle);
        if (window == IntPtr.Zero) return false;
        var current = GetWindowLongPtr(window, GWL_EXSTYLE).ToInt64();
        // WS_EX_NOACTIVATE normally suppresses a taskbar button.  Pair it
        // with WS_EX_APPWINDOW so Yoiniwa remains directly reachable from the
        // taskbar while Photoshop keeps foreground ownership during picking.
        var next = current | WS_EX_APPWINDOW;
        if (enabled) next |= WS_EX_NOACTIVATE;
        else next &= ~WS_EX_NOACTIVATE;
        if (next == current) return true;
        SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(next));
        return SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    private static IntPtr TaskbarForWindow(IntPtr window)
    {
        var monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        var primaryTaskbar = FindWindow("Shell_TrayWnd", null);
        if (primaryTaskbar == IntPtr.Zero) return IntPtr.Zero;
        var taskbar = MonitorFromWindow(primaryTaskbar, MONITOR_DEFAULTTONEAREST) == monitor
            ? primaryTaskbar : IntPtr.Zero;
        if (taskbar == IntPtr.Zero)
        {
            var secondary = IntPtr.Zero;
            while ((secondary = FindWindowEx(IntPtr.Zero, secondary, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero)
            {
                if (MonitorFromWindow(secondary, MONITOR_DEFAULTTONEAREST) == monitor)
                {
                    taskbar = secondary;
                    break;
                }
            }
        }
        return taskbar;
    }

    private static bool IsBehindTaskbar(IntPtr window, IntPtr taskbar)
    {
        var current = GetWindow(taskbar, GW_HWNDNEXT);
        for (var index = 0; current != IntPtr.Zero && index < 2048; index += 1)
        {
            if (current == window) return true;
            current = GetWindow(current, GW_HWNDNEXT);
        }
        return false;
    }

    public static bool PlaceBelowTaskbar(long rawHandle)
    {
        var window = new IntPtr(rawHandle);
        if (window == IntPtr.Zero) return false;
        var taskbar = TaskbarForWindow(window);
        if (taskbar == IntPtr.Zero) return false;
        if (IsBehindTaskbar(window, taskbar)) return true;
        var placed = SetWindowPos(window, taskbar, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        if (placed) DwmFlush();
        return placed;
    }

    public static bool PlaceAboveTaskbar(long rawHandle)
    {
        var window = new IntPtr(rawHandle);
        if (window == IntPtr.Zero) return false;
        var placed = SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        if (placed) DwmFlush();
        return placed;
    }

    public static bool SetCollaborationLayer(long rawHandle, bool enabled, bool aboveTaskbar)
    {
        var window = new IntPtr(rawHandle);
        if (window == IntPtr.Zero || !SetNoActivate(rawHandle, enabled)) return false;
        return !enabled || (aboveTaskbar ? PlaceAboveTaskbar(rawHandle) : PlaceBelowTaskbar(rawHandle));
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
        Rect bounds;
        return window != IntPtr.Zero && GetWindowRect(window, out bounds)
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
        var window = new IntPtr(Interlocked.Read(ref inputWindowHandle));
        var inside = PointInsideWindow(window, data.Position);
        var alt = IsKeyDown(VK_MENU);
        var space = IsKeyDown(VK_SPACE);
        var mode = Volatile.Read(ref inputMode);
        var expired = mode != INPUT_NONE
            && unchecked(Environment.TickCount - Volatile.Read(ref inputStartedAt)) > 15000;
        var physicalReleaseMissed = mode != INPUT_NONE && message != WM_LBUTTONUP && !IsKeyDown(VK_LBUTTON);
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
                return new IntPtr(1);
            }
            if (mode == INPUT_PAN)
            {
                EmitPointer("MOVE", data, alt, space, 0);
                return new IntPtr(1);
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
            else SetInputMode(INPUT_BLOCK);
            return new IntPtr(1);
        }

        if (message == WM_LBUTTONUP && mode != INPUT_NONE)
        {
            if (mode == INPUT_PICK)
                EmitPointer(alt ? "UP" : "CANCEL", data, alt, space, 0);
            else if (mode == INPUT_PAN) EmitPointer("UP", data, alt, space, 0);
            SetInputMode(INPUT_NONE);
            return new IntPtr(1);
        }

        if ((message == WM_RBUTTONDOWN || message == WM_RBUTTONUP) && (inside || mode != INPUT_NONE))
            return new IntPtr(1);

        if ((message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) && inside)
        {
            var delta = unchecked((short)((data.MouseData >> 16) & 0xFFFF));
            EmitPointer(message == WM_MOUSEHWHEEL ? "HWHEEL" : "WHEEL", data, alt, space, delta);
            return new IntPtr(1);
        }

        return CallNextHookEx(hookHandle, code, wParam, lParam);
    }

    private static void InputHookLoop()
    {
        hookProcedure = InputHook;
        hookHandle = SetWindowsHookEx(WH_MOUSE_LL, hookProcedure, GetModuleHandle(null), 0);
        HookStarted.Set();
        if (hookHandle == IntPtr.Zero) return;
        Message message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        UnhookWindowsHookEx(hookHandle);
        hookHandle = IntPtr.Zero;
    }

    public static bool ConfigureInput(long rawHandle, bool enabled)
    {
        if (enabled)
        {
            lock (HookLock)
            {
                if (hookThread == null)
                {
                    HookStarted.Reset();
                    hookThread = new Thread(InputHookLoop);
                    hookThread.IsBackground = true;
                    hookThread.Name = "Yoiniwa collaboration input";
                    hookThread.Start();
                }
            }
            if (!HookStarted.Wait(1500) || hookHandle == IntPtr.Zero) return false;
        }
        SetInputMode(INPUT_NONE);
        Interlocked.Exchange(ref inputWindowHandle, rawHandle);
        Volatile.Write(ref inputEnabled, enabled ? 1 : 0);
        return true;
    }

}
'@

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $parts = $line.Split('|')
        if (($parts.Length -eq 4 -or $parts.Length -eq 5) -and $parts[0] -eq 'LAYER') {
            $enabled = $parts[3] -eq '1'
            $aboveTaskbar = $parts.Length -eq 5 -and $parts[4] -eq '1'
            $applied = [RefCanvasNativeWindowMove]::SetCollaborationLayer([long]::Parse($parts[2]), $enabled, $aboveTaskbar)
            [Console]::Out.WriteLine('LAYER|' + $parts[1] + '|' + $(if ($applied) { 'READY' } else { 'FAILED' }))
        } elseif ($parts.Length -eq 4 -and $parts[0] -eq 'INPUT') {
            $enabled = $parts[3] -eq '1'
            $applied = [RefCanvasNativeWindowMove]::ConfigureInput([long]::Parse($parts[2]), $enabled)
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
