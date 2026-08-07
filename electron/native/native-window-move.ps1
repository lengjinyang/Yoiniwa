$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class RefCanvasNativeWindowMove
{
    private const int VK_RBUTTON = 0x02;
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

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

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
        var placed = SetWindowPos(window, taskbar, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        if (placed) DwmFlush();
        return placed;
    }

    public static bool SetCollaborationLayer(long rawHandle, bool enabled)
    {
        var window = new IntPtr(rawHandle);
        if (window == IntPtr.Zero || !SetNoActivate(rawHandle, enabled)) return false;
        return !enabled || PlaceBelowTaskbar(rawHandle);
    }

}
'@

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $parts = $line.Split('|')
        if ($parts.Length -eq 4 -and $parts[0] -eq 'LAYER') {
            $enabled = $parts[3] -eq '1'
            $applied = [RefCanvasNativeWindowMove]::SetCollaborationLayer([long]::Parse($parts[2]), $enabled)
            [Console]::Out.WriteLine('LAYER|' + $parts[1] + '|' + $(if ($applied) { 'READY' } else { 'FAILED' }))
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
