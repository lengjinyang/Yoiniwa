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
        if (next != current) SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(next));
        return SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    public static bool PlaceBelowTaskbar(long rawHandle)
    {
        var window = new IntPtr(rawHandle);
        if (window == IntPtr.Zero) return false;
        var monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        var primaryTaskbar = FindWindow("Shell_TrayWnd", null);
        if (primaryTaskbar == IntPtr.Zero) return false;
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
        if (taskbar == IntPtr.Zero) return false;
        var belowTaskbar = GetWindow(taskbar, GW_HWNDNEXT);
        if (belowTaskbar == IntPtr.Zero) return false;
        if (belowTaskbar == window) return true;
        var placed = SetWindowPos(window, belowTaskbar, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        if (placed) DwmFlush();
        return placed;
    }

}
'@

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $parts = $line.Split('|')
        if ($parts.Length -eq 2 -and $parts[0] -eq 'TASKBAR') {
            $placed = [RefCanvasNativeWindowMove]::PlaceBelowTaskbar([long]::Parse($parts[1]))
            [Console]::Out.WriteLine($(if ($placed) { 'TASKBAR_DONE' } else { 'TASKBAR_SKIPPED' }))
        } elseif ($parts.Length -eq 3 -and $parts[0] -eq 'FOCUSLESS') {
            $enabled = $parts[2] -eq '1'
            $applied = [RefCanvasNativeWindowMove]::SetNoActivate([long]::Parse($parts[1]), $enabled)
            [Console]::Out.WriteLine($(if ($applied) { 'FOCUSLESS_DONE' } else { 'FOCUSLESS_SKIPPED' }))
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
