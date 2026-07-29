$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class RefCanvasNativeWindowMove
{
    private const int VK_RBUTTON = 0x02;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

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
}
'@

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $handle = [long]::Parse($line)
        $moved = [RefCanvasNativeWindowMove]::Begin($handle)
        [Console]::Out.WriteLine($(if ($moved) { 'DONE' } else { 'SKIPPED' }))
    } catch {
        [Console]::Out.WriteLine("ERROR $($_.Exception.Message)")
    }
    [Console]::Out.Flush()
}
