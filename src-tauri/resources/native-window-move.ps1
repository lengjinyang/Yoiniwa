$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
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
    private const int VK_LMENU = 0xA4;
    private const int VK_RMENU = 0xA5;
    private const int VK_SPACE = 0x20;
    private const int VK_ADD = 0x6B;
    private const int VK_SUBTRACT = 0x6D;
    private const int VK_OEM_PLUS = 0xBB;
    private const int VK_OEM_MINUS = 0xBD;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_MOUSEHWHEEL = 0x020E;
    private const int WM_MOUSEACTIVATE = 0x0021;
    private const int WM_POINTERUPDATE = 0x0245;
    private const int WM_POINTERDOWN = 0x0246;
    private const int WM_POINTERUP = 0x0247;
    private const int WM_DESTROY = 0x0002;
    private const int MA_NOACTIVATE = 3;
    private const uint PT_TOUCH = 2;
    private const uint PT_PEN = 3;
    private const uint ERROR_CLASS_ALREADY_EXISTS = 1410;
    private const int WM_SETCURSOR = 0x0020;
    private const int GCLP_HCURSOR = -12;
    private const int IDC_ARROW = 32512;
    private const uint WM_CLOSE = 0x0010;
    private const int SW_SHOWNOACTIVATE = 4;
    private const uint WS_POPUP = 0x80000000;
    private const uint WS_EX_TOPMOST = 0x00000008;
    private const uint WS_EX_TOOLWINDOW = 0x00000080;
    private const uint WS_EX_NOACTIVATE = 0x08000000;
    private const uint WS_EX_LAYERED = 0x00080000;
    private const uint LWA_ALPHA = 0x00000002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const int DWMWA_NCRENDERING_POLICY = 2;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
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
    private delegate IntPtr WndProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WndClassEx
    {
        public uint cbSize;
        public uint style;
        public WndProc lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PointerInfo
    {
        public uint pointerType;
        public uint pointerId;
        public uint frameId;
        public uint pointerFlags;
        public IntPtr sourceDevice;
        public IntPtr hwndTarget;
        public Point ptPixelLocation;
        public Point ptHimetricLocation;
        public Point ptPixelLocationRaw;
        public Point ptHimetricLocationRaw;
        public uint dwTime;
        public uint historyCount;
        public int inputData;
        public uint dwKeyStates;
        public ulong performanceCount;
        public uint buttonChangeType;
    }

    private static readonly ConcurrentQueue<string> outputQueue = new ConcurrentQueue<string>();
    private static readonly AutoResetEvent outputPulse = new AutoResetEvent(false);
    private static int outputWriterStarted;
    private static int pendingPointer;
    private static int pendingPointerKind; // 1 = MOVE, 2 = HOVER
    private static int pendingPointerX;
    private static int pendingPointerY;
    private static int pendingPointerAlt;
    private static int pendingPointerSpace;
    private static int pendingPointerPen;
    private static int hitBoundsLeft;
    private static int hitBoundsTop;
    private static int hitBoundsRight;
    private static int hitBoundsBottom;
    private static int hitBoundsTick;
    private static int hitBoundsValid;
    private static readonly object HookLock = new object();
    private static readonly object LayerLock = new object();
    private static readonly ManualResetEventSlim HookStarted = new ManualResetEventSlim(false);
    private static readonly ManualResetEventSlim LayerStarted = new ManualResetEventSlim(false);
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private static Thread hookThread;
    private static Thread layerThread;
    private static MouseHookProc hookProcedure;
    private static KeyboardHookProc keyboardHookProcedure;
    private static IntPtr hookHandle = IntPtr.Zero;
    private static IntPtr keyboardHookHandle = IntPtr.Zero;
    private static long layerWindowHandle;
    private static long layerOwnerHandle;
    private static int layerReady;
    private static int layerThreadId;
    private static int hookPhysicalCoordinatesReady;
    private static int hookThreadId;
    private static long inputWindowHandle;
    private static int inputEnabled;
    private static int collaborationZoomEnabled;
    private static int inputMode;
    private static int inputStartedAt;
    private static int altKeyDown;
    private static int spaceKeyDown;
    private static int inputPointerIsPen;
    private static int rightMoveActive;
    private static int suppressRightUntilUp;
    private static int missedReleaseMoveCount;
    private static int overlayPointerStream;
    private static int contactX;
    private static int contactY;
    private static int contactValid;
    private static WndProc layerWindowProcedure;
    private static IntPtr overlayCursor;
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
    private static extern bool GetClientRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr window, ref Point point);

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

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowEx(
        uint extendedStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu,
        IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetLayeredWindowAttributes(IntPtr window, uint colorKey, byte alpha, uint flags);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WndClassEx windowClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool GetPointerInfo(uint pointerId, out PointerInfo info);

    [DllImport("user32.dll")]
    private static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursor);

    [DllImport("user32.dll")]
    private static extern IntPtr SetCursor(IntPtr cursor);

    [DllImport("user32.dll", EntryPoint = "SetClassLongPtr")]
    private static extern IntPtr SetClassLongPtr(IntPtr window, int index, IntPtr value);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int exitCode);

    [DllImport("kernel32.dll")]
    private static extern uint GetLastError();

    [DllImport("kernel32.dll")]
    private static extern int GetCurrentThreadId();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int valueSize);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect bounds, int size);

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
                MoveInputLayer(window);
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

    private static bool IsAltDown()
    {
        return Volatile.Read(ref altKeyDown) != 0 || IsKeyDown(VK_MENU);
    }

    private static bool IsSpaceDown()
    {
        return Volatile.Read(ref spaceKeyDown) != 0 || IsKeyDown(VK_SPACE);
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

    private static void MoveInputLayer(IntPtr owner)
    {
        // stdin/right-move threads are not the overlay thread. Match PMv2 so
        // DWM/client bounds and SetWindowPos use the same physical pixels as
        // the hook and the original CreateWindowEx call.
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        var layer = new IntPtr(Interlocked.Read(ref layerWindowHandle));
        if (layer == IntPtr.Zero || !IsWindow(layer)) return;
        Rect bounds;
        if (owner == IntPtr.Zero || !TryGetVisibleScreenBounds(owner, out bounds)
            || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) return;
        // Keep the established Z order and never activate either window.
        SetWindowPos(layer, IntPtr.Zero, bounds.Left, bounds.Top,
            bounds.Right - bounds.Left, bounds.Bottom - bounds.Top,
            SWP_NOZORDER | SWP_NOACTIVATE);
        InvalidateHitBounds();
    }

    private static IntPtr OverlayArrowCursor()
    {
        var cursor = overlayCursor;
        if (cursor != IntPtr.Zero) return cursor;
        cursor = LoadCursor(IntPtr.Zero, new IntPtr(IDC_ARROW));
        overlayCursor = cursor;
        return cursor;
    }

    private static IntPtr LayerWndProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (message == WM_SETCURSOR)
            {
                SetCursor(OverlayArrowCursor());
                return new IntPtr(1);
            }
            if (message == WM_MOUSEACTIVATE) return new IntPtr(MA_NOACTIVATE);
            if (message == WM_POINTERDOWN || message == WM_POINTERUPDATE || message == WM_POINTERUP)
            {
                SetCursor(OverlayArrowCursor());
                HandleLayerPointer(message, wParam);
                return IntPtr.Zero;
            }
            if (message == WM_CLOSE)
            {
                DestroyWindow(window);
                return IntPtr.Zero;
            }
            if (message == WM_DESTROY)
            {
                PostQuitMessage(0);
                return IntPtr.Zero;
            }
        }
        catch { }
        return DefWindowProc(window, message, wParam, lParam);
    }

    private static void HandleLayerPointer(uint message, IntPtr wParam)
    {
        if (Volatile.Read(ref inputEnabled) == 0) return;
        var pointerId = (uint)(wParam.ToInt64() & 0xFFFF);
        PointerInfo info;
        if (!GetPointerInfo(pointerId, out info)) return;
        var pen = info.pointerType == PT_PEN || info.pointerType == PT_TOUCH;
        var x = info.ptPixelLocation.X;
        var y = info.ptPixelLocation.Y;
        if (message == WM_POINTERDOWN) HandleOverlayContact("DOWN", x, y, pen);
        else if (message == WM_POINTERUPDATE) HandleOverlayContact("MOVE", x, y, pen);
        else HandleOverlayContact("UP", x, y, pen);
    }

    private static void HandleOverlayContact(string kind, int x, int y, bool pen)
    {
        var mode = Volatile.Read(ref inputMode);
        var alt = IsAltDown();
        var space = IsSpaceDown();
        var point = new Point { X = x, Y = y };
        if (kind == "DOWN")
        {
            Volatile.Write(ref overlayPointerStream, 1);
            Volatile.Write(ref contactX, x);
            Volatile.Write(ref contactY, y);
            Volatile.Write(ref contactValid, 1);
            if (pen) Volatile.Write(ref inputPointerIsPen, 1);
            if (mode == INPUT_NONE && alt)
            {
                SetInputMode(INPUT_PICK);
                EmitActivePointer("DOWN", point, true, space);
                QueueCoalescedPointer("MOVE", x, y, true, space, true);
                return;
            }
            if (mode == INPUT_BLOCK && alt)
            {
                SetInputMode(INPUT_PICK);
                EmitActivePointer("DOWN", point, true, space);
                QueueCoalescedPointer("MOVE", x, y, true, space, true);
                return;
            }
            if (mode == INPUT_PICK)
                QueueCoalescedPointer("MOVE", x, y, true, space, pen);
            return;
        }
        if (kind == "MOVE")
        {
            if (mode == INPUT_BLOCK && alt)
            {
                SetInputMode(INPUT_PICK);
                var origin = point;
                if (Volatile.Read(ref contactValid) != 0)
                    origin = new Point { X = Volatile.Read(ref contactX), Y = Volatile.Read(ref contactY) };
                EmitActivePointer("DOWN", origin, true, space);
                QueueCoalescedPointer("MOVE", x, y, true, space, pen || Volatile.Read(ref inputPointerIsPen) != 0);
                return;
            }
            if (mode == INPUT_PICK)
            {
                Volatile.Write(ref overlayPointerStream, 1);
                QueueCoalescedPointer("MOVE", x, y, true, space,
                    pen || Volatile.Read(ref inputPointerIsPen) != 0);
            }
            return;
        }
        Volatile.Write(ref overlayPointerStream, 0);
        if (mode == INPUT_PICK)
        {
            EmitActivePointer("UP", point, true, space);
            SetInputMode(INPUT_NONE);
        }
    }

    private static void InputLayerLoop()
    {
        IntPtr window = IntPtr.Zero;
        Volatile.Write(ref layerThreadId, GetCurrentThreadId());
        try
        {
            if (SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == IntPtr.Zero)
                return;
            var owner = new IntPtr(Interlocked.Read(ref layerOwnerHandle));
            Rect bounds;
            if (owner == IntPtr.Zero || !IsWindow(owner) || !TryGetVisibleScreenBounds(owner, out bounds)
                || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top)
                return;

            // Helper-owned class. A managed WndProc is safe here because this
            // HWND has no foreign-process owner; it only receives our overlay
            // pointer packets so short tablet drags still produce MOVE.
            layerWindowProcedure = LayerWndProc;
            var className = "YoiniwaCollabInputLayer";
            var windowClass = new WndClassEx();
            windowClass.cbSize = (uint)Marshal.SizeOf(typeof(WndClassEx));
            windowClass.lpfnWndProc = layerWindowProcedure;
            var arrow = OverlayArrowCursor();
            windowClass.hCursor = arrow;
            windowClass.hInstance = GetModuleHandle(null);
            windowClass.lpszClassName = className;
            if (RegisterClassEx(ref windowClass) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
                return;

            window = CreateWindowEx(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
                className, "", WS_POPUP,
                bounds.Left, bounds.Top, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top,
                IntPtr.Zero, IntPtr.Zero, windowClass.hInstance, IntPtr.Zero);
            if (window == IntPtr.Zero) return;
            if (arrow != IntPtr.Zero) SetClassLongPtr(window, GCLP_HCURSOR, arrow);
            SetCursor(arrow);

            // Alpha must be non-zero: fully transparent layered pixels are omitted
            // from User32 hit testing and would let Alt+tip reach Photoshop.
            if (!SetLayeredWindowAttributes(window, 0, 1, LWA_ALPHA))
            {
                DestroyWindow(window);
                window = IntPtr.Zero;
                return;
            }
            Interlocked.Exchange(ref layerWindowHandle, window.ToInt64());
            var cornerPreference = DWMWCP_DONOTROUND;
            DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, ref cornerPreference, sizeof(int));
            ShowWindow(window, SW_SHOWNOACTIVATE);
            SetWindowPos(window, HWND_TOPMOST, bounds.Left, bounds.Top,
                bounds.Right - bounds.Left, bounds.Bottom - bounds.Top,
                SWP_NOACTIVATE | SWP_SHOWWINDOW);
            Volatile.Write(ref layerReady, 1);
            LayerStarted.Set();

            Message message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        finally
        {
            if (!LayerStarted.IsSet) LayerStarted.Set();
            if (window != IntPtr.Zero && IsWindow(window)) DestroyWindow(window);
            Interlocked.Exchange(ref layerWindowHandle, 0);
            Interlocked.Exchange(ref layerOwnerHandle, 0);
            Volatile.Write(ref layerReady, 0);
            Volatile.Write(ref layerThreadId, 0);
        }
    }

    private static bool ReleaseInputLayer(bool force)
    {
        if (!force && (Volatile.Read(ref inputMode) != INPUT_NONE || IsKeyDown(VK_LBUTTON)
            || Volatile.Read(ref rightMoveActive) != 0 || Volatile.Read(ref suppressRightUntilUp) != 0))
            return false;

        Thread thread;
        IntPtr window;
        lock (LayerLock)
        {
            thread = layerThread;
            window = new IntPtr(Interlocked.Read(ref layerWindowHandle));
        }
        if (window != IntPtr.Zero && IsWindow(window))
            PostMessage(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        var threadId = Volatile.Read(ref layerThreadId);
        if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);

        if (thread != null && thread.IsAlive && !thread.Join(force ? 1200 : 800))
            return false;
        lock (LayerLock)
        {
            if (layerThread == thread) layerThread = null;
        }
        Interlocked.Exchange(ref layerWindowHandle, 0);
        Interlocked.Exchange(ref layerOwnerHandle, 0);
        Volatile.Write(ref layerReady, 0);
        LayerStarted.Reset();
        return true;
    }

    public static string ConfigureInputLayer(long rawHandle, bool enabled)
    {
        if (!enabled) return ReleaseInputLayer(false) ? "RELEASED" : "FAILED";
        if (Volatile.Read(ref inputMode) != INPUT_NONE || IsKeyDown(VK_LBUTTON)
            || IsKeyDown(VK_RBUTTON) || Volatile.Read(ref rightMoveActive) != 0)
            return "FAILED";
        var owner = new IntPtr(rawHandle);
        if (owner == IntPtr.Zero || !IsWindow(owner)) return "FAILED";
        if (Volatile.Read(ref layerReady) != 0
            && Interlocked.Read(ref layerOwnerHandle) == rawHandle
            && IsWindow(new IntPtr(Interlocked.Read(ref layerWindowHandle))))
        {
            // set_resizable(false) and DWM placement can change the visible
            // rect after the overlay is first created. Sync while idle only —
            // never SetWindowPos during an active pick/pan contact.
            if (Volatile.Read(ref inputMode) == INPUT_NONE && !IsKeyDown(VK_LBUTTON)
                && Volatile.Read(ref rightMoveActive) == 0)
                MoveInputLayer(owner);
            return "READY";
        }

        lock (LayerLock)
        {
            if (layerThread != null && layerThread.IsAlive) return "FAILED";
            Interlocked.Exchange(ref layerOwnerHandle, rawHandle);
            LayerStarted.Reset();
            Volatile.Write(ref layerReady, 0);
            layerThread = new Thread(InputLayerLoop);
            layerThread.IsBackground = true;
            layerThread.Name = "Yoiniwa native input layer";
            layerThread.Start();
        }
        if (!LayerStarted.Wait(1800) || Volatile.Read(ref layerReady) == 0
            || !IsWindow(new IntPtr(Interlocked.Read(ref layerWindowHandle))))
        {
            ReleaseInputLayer(true);
            return "FAILED";
        }
        return "READY";
    }

    public static void ShutdownInputLayer()
    {
        ReleaseInputLayer(true);
    }

    private static void EnsureOutputWriter()
    {
        if (Interlocked.CompareExchange(ref outputWriterStarted, 1, 0) != 0) return;
        var thread = new Thread(OutputWriterLoop);
        thread.IsBackground = true;
        thread.Name = "Yoiniwa pointer output";
        thread.Start();
    }

    private static void OutputWriterLoop()
    {
        while (true)
        {
            outputPulse.WaitOne(50);
            for (;;)
            {
                string line;
                var wrote = false;
                while (outputQueue.TryDequeue(out line))
                {
                    if (line.StartsWith("POINTER|DOWN|") && Volatile.Read(ref pendingPointerKind) == 2)
                        Interlocked.Exchange(ref pendingPointer, 0);
                    if (line.StartsWith("POINTER|UP|") || line.StartsWith("POINTER|CANCEL|"))
                        FlushPendingPointer();
                    Console.Out.WriteLine(line);
                    wrote = true;
                }
                var hadMove = Volatile.Read(ref pendingPointer) != 0;
                FlushPendingPointer();
                if (wrote || hadMove)
                {
                    try { Console.Out.Flush(); } catch { }
                }
                if (Volatile.Read(ref pendingPointer) == 0 && !outputQueue.TryPeek(out line)) break;
            }
        }
    }

    private static void FlushPendingPointer()
    {
        if (Interlocked.Exchange(ref pendingPointer, 0) == 0) return;
        var hover = Volatile.Read(ref pendingPointerKind) == 2;
        Console.Out.WriteLine(PointerLine(
            hover ? "HOVER" : "MOVE",
            Volatile.Read(ref pendingPointerX),
            Volatile.Read(ref pendingPointerY),
            Volatile.Read(ref pendingPointerAlt) != 0,
            Volatile.Read(ref pendingPointerSpace) != 0,
            Volatile.Read(ref pendingPointerPen) != 0 ? "pen" : "mouse",
            0));
    }

    private static void QueueCoalescedPointer(string kind, int x, int y, bool alt, bool space, bool pen)
    {
        EnsureOutputWriter();
        Volatile.Write(ref pendingPointerX, x);
        Volatile.Write(ref pendingPointerY, y);
        Volatile.Write(ref pendingPointerAlt, alt ? 1 : 0);
        Volatile.Write(ref pendingPointerSpace, space ? 1 : 0);
        Volatile.Write(ref pendingPointerPen, pen ? 1 : 0);
        Volatile.Write(ref pendingPointerKind, kind == "HOVER" ? 2 : 1);
        Volatile.Write(ref pendingPointer, 1);
        outputPulse.Set();
    }

    private static void Emit(string line)
    {
        EnsureOutputWriter();
        outputQueue.Enqueue(line);
        outputPulse.Set();
    }

    private static void InvalidateHitBounds()
    {
        Volatile.Write(ref hitBoundsValid, 0);
    }

    private static bool TryGetCachedVisibleBounds(IntPtr window, out Rect bounds)
    {
        bounds = new Rect();
        var now = Environment.TickCount;
        if (Volatile.Read(ref hitBoundsValid) != 0
            && unchecked(now - Volatile.Read(ref hitBoundsTick)) < 250)
        {
            bounds.Left = Volatile.Read(ref hitBoundsLeft);
            bounds.Top = Volatile.Read(ref hitBoundsTop);
            bounds.Right = Volatile.Read(ref hitBoundsRight);
            bounds.Bottom = Volatile.Read(ref hitBoundsBottom);
            return true;
        }
        if (!TryGetVisibleScreenBounds(window, out bounds)) return false;
        Volatile.Write(ref hitBoundsLeft, bounds.Left);
        Volatile.Write(ref hitBoundsTop, bounds.Top);
        Volatile.Write(ref hitBoundsRight, bounds.Right);
        Volatile.Write(ref hitBoundsBottom, bounds.Bottom);
        Volatile.Write(ref hitBoundsTick, now);
        Volatile.Write(ref hitBoundsValid, 1);
        return true;
    }

    private static bool TryGetClientScreenBounds(IntPtr window, out Rect bounds)
    {
        bounds = new Rect();
        Rect client;
        if (window == IntPtr.Zero || !IsWindow(window) || !GetClientRect(window, out client)) return false;
        var topLeft = new Point { X = client.Left, Y = client.Top };
        var bottomRight = new Point { X = client.Right, Y = client.Bottom };
        if (!ClientToScreen(window, ref topLeft) || !ClientToScreen(window, ref bottomRight)) return false;
        bounds.Left = topLeft.X;
        bounds.Top = topLeft.Y;
        bounds.Right = bottomRight.X;
        bounds.Bottom = bottomRight.Y;
        return true;
    }

    private static Rect UnionBounds(Rect left, Rect right)
    {
        return new Rect
        {
            Left = Math.Min(left.Left, right.Left),
            Top = Math.Min(left.Top, right.Top),
            Right = Math.Max(left.Right, right.Right),
            Bottom = Math.Max(left.Bottom, right.Bottom),
        };
    }

    private static bool TryGetVisibleScreenBounds(IntPtr window, out Rect bounds)
    {
        // Cover every pixel the user can see as canvas. GetClientRect is the
        // WebView; DWM extended frame is the visible window. The union is never
        // smaller than the board. Collaboration makes the main HWND click-through,
        // so a too-small overlay lets Alt+tip reach Photoshop.
        bounds = new Rect();
        if (window == IntPtr.Zero || !IsWindow(window)) return false;
        Rect client;
        var hasClient = TryGetClientScreenBounds(window, out client)
            && client.Right > client.Left && client.Bottom > client.Top;
        Rect visible;
        var hasVisible = DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, out visible,
                Marshal.SizeOf(typeof(Rect))) == 0
            && visible.Right > visible.Left && visible.Bottom > visible.Top;
        if (!hasVisible)
        {
            hasVisible = GetWindowRect(window, out visible)
                && visible.Right > visible.Left && visible.Bottom > visible.Top;
        }
        if (hasClient && hasVisible)
        {
            bounds = UnionBounds(client, visible);
            return true;
        }
        if (hasVisible) { bounds = visible; return true; }
        if (hasClient) { bounds = client; return true; }
        return false;
    }

    private static bool PointInsideWindow(IntPtr window, Point point)
    {
        // Destroyed HWNDs can be reused by unrelated windows. Never treat a
        // stale handle as "inside" or the LL hook will swallow system clicks.
        if (window == IntPtr.Zero || !IsWindow(window)) return false;
        Rect bounds;
        return TryGetCachedVisibleBounds(window, out bounds)
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

    private static string PointerLine(string kind, int x, int y, bool alt, bool space, string pointerType, int delta)
    {
        Rect bounds;
        var window = new IntPtr(Interlocked.Read(ref inputWindowHandle));
        if (!TryGetCachedVisibleBounds(window, out bounds))
        {
            bounds.Left = x;
            bounds.Top = y;
            bounds.Right = x + 1;
            bounds.Bottom = y + 1;
        }
        return "POINTER|" + kind + "|" + x + "|" + y
            + "|" + (alt ? "1" : "0") + "|" + (space ? "1" : "0")
            + "|" + pointerType + "|" + delta
            + "|" + bounds.Left + "|" + bounds.Top + "|" + bounds.Right + "|" + bounds.Bottom;
    }

    private static void EmitPointer(string kind, MouseHookData data, bool alt, bool space, int delta)
    {
        if (kind == "MOVE" || kind == "HOVER")
        {
            var extra = data.ExtraInfo.ToInt64();
            var pen = Volatile.Read(ref inputPointerIsPen) != 0
                || (extra & 0xFFFFFF00L) == 0xFF515700L
                || (extra & 0xFFFFFF00L) == 0xFF515600L;
            QueueCoalescedPointer(kind, data.Position.X, data.Position.Y, alt, space, pen);
            return;
        }
        if (kind == "DOWN" && Volatile.Read(ref pendingPointerKind) == 2)
            Interlocked.Exchange(ref pendingPointer, 0);
        Emit(PointerLine(kind, data.Position.X, data.Position.Y, alt, space, PointerType(data), delta));
    }

    private static void EmitActivePointer(string kind, Point point, bool alt, bool space)
    {
        if (kind == "MOVE" || kind == "HOVER")
        {
            QueueCoalescedPointer(kind, point.X, point.Y, alt, space,
                Volatile.Read(ref inputPointerIsPen) != 0);
            return;
        }
        Emit(PointerLine(kind, point.X, point.Y, alt, space,
            Volatile.Read(ref inputPointerIsPen) != 0 ? "pen" : "mouse", 0));
    }

    private static void PromoteBlockedGesture(bool pick)
    {
        if (Volatile.Read(ref inputMode) != INPUT_BLOCK) return;
        // Key auto-repeat can arrive after a missed tip-up. Only promote while
        // the physical primary contact is still down.
        if (!IsKeyDown(VK_LBUTTON)) return;
        Point cursor;
        var window = new IntPtr(Interlocked.Read(ref inputWindowHandle));
        if (!GetCursorPos(out cursor) || !PointInsideWindow(window, cursor)) return;
        var origin = cursor;
        if (Volatile.Read(ref contactValid) != 0)
            origin = new Point { X = Volatile.Read(ref contactX), Y = Volatile.Read(ref contactY) };
        SetInputMode(pick ? INPUT_PICK : INPUT_PAN);
        EmitActivePointer("DOWN", origin, pick, !pick);
        EmitActivePointer("MOVE", cursor, pick, !pick);
    }

    private static void SetInputMode(int mode)
    {
        var previous = Interlocked.Exchange(ref inputMode, mode);
        Interlocked.Exchange(ref inputStartedAt, mode == INPUT_NONE ? 0 : Environment.TickCount);
        Interlocked.Exchange(ref missedReleaseMoveCount, 0);
        if (mode == INPUT_NONE) Volatile.Write(ref overlayPointerStream, 0);
        if (mode == INPUT_NONE) Volatile.Write(ref contactValid, 0);
        if (mode == INPUT_NONE) Volatile.Write(ref inputPointerIsPen, 0);
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

    private static bool MissedReleaseFromMove(MouseHookData data, bool alt, bool space)
    {
        if (IsKeyDown(VK_LBUTTON))
        {
            Interlocked.Exchange(ref missedReleaseMoveCount, 0);
            return false;
        }
        // Wacom can report a single MOVE with the button already up. Require a
        // few consecutive packets before treating the physical UP as lost.
        if (Interlocked.Increment(ref missedReleaseMoveCount) < 3) return false;
        EmitPointer("CANCEL", data, alt, space, 0);
        SetInputMode(INPUT_NONE);
        return true;
    }

    private static void EmitIdleHoverEnd()
    {
        if (Volatile.Read(ref inputMode) != INPUT_NONE) return;
        Point cursor;
        var window = new IntPtr(Interlocked.Read(ref inputWindowHandle));
        if (!GetCursorPos(out cursor) || !PointInsideWindow(window, cursor)) return;
        // Pen hover is the only path that shows the collaboration reticle.
        // A mouse Alt+click never leaves that overlay, so this packet is safe.
        Emit(PointerLine("HOVER", cursor.X, cursor.Y, false, IsSpaceDown(), "pen", 0));
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
            Volatile.Write(ref altKeyDown, 0);
            Volatile.Write(ref spaceKeyDown, 0);
            SetInputMode(INPUT_NONE);
            Interlocked.Exchange(ref inputWindowHandle, 0);
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }
        var alt = IsAltDown();
        var space = IsSpaceDown();
        var mode = Volatile.Read(ref inputMode);
        // An active pick/pan already owns this contact. Skip DWM hit-testing on
        // MOVE/UP so the low-level hook stays as cheap as a normal mouse drag.
        var inside = ((mode == INPUT_PICK || mode == INPUT_PAN)
            && (message == WM_MOUSEMOVE || message == WM_LBUTTONUP))
            || PointInsideWindow(window, data.Position);
        var expired = mode != INPUT_NONE
            && unchecked(Environment.TickCount - Volatile.Read(ref inputStartedAt)) > 15000;
        var physicalReleaseMissed = mode != INPUT_NONE && message != WM_LBUTTONUP
            && message != WM_MOUSEMOVE && !IsKeyDown(VK_LBUTTON);
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
                if (MissedReleaseFromMove(data, true, space))
                    return CallNextHookEx(hookHandle, code, wParam, lParam);
                // Overlay WM_POINTERUPDATE already tracks the pen. Mouse MOVE
                // is often missing for short Ink drags; skip duplicates when
                // the overlay stream is live so the HUD does not snap back.
                if (Volatile.Read(ref overlayPointerStream) == 0)
                    EmitPointer("MOVE", data, true, space, 0);
                return CallNextHookEx(hookHandle, code, wParam, lParam);
            }
            if (mode == INPUT_PAN)
            {
                if (MissedReleaseFromMove(data, alt, space))
                    return CallNextHookEx(hookHandle, code, wParam, lParam);
                EmitPointer("MOVE", data, alt, space, 0);
                return CallNextHookEx(hookHandle, code, wParam, lParam);
            }
            if (mode == INPUT_BLOCK)
            {
                if (!inside) return CallNextHookEx(hookHandle, code, wParam, lParam);
                // Some tablet drivers publish the modifier a packet after tip-down.
                // Promote the still-active contact instead of leaving the gesture
                // permanently blocked for the rest of the drag.
                if (alt)
                {
                    SetInputMode(INPUT_PICK);
                    EmitPointer("DOWN", data, true, space, 0);
                    EmitPointer("MOVE", data, true, space, 0);
                }
                else if (space)
                {
                    SetInputMode(INPUT_PAN);
                    EmitPointer("DOWN", data, false, true, 0);
                    EmitPointer("MOVE", data, false, true, 0);
                }
                return CallNextHookEx(hookHandle, code, wParam, lParam);
            }
            if (inside && alt && !IsKeyDown(VK_LBUTTON)) EmitPointer("HOVER", data, true, space, 0);
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        if (message == WM_LBUTTONDOWN && inside)
        {
            // A fresh physical DOWN is an authoritative contact boundary. If a
            // driver omitted the previous UP, cancel that stale gesture before
            // classifying this one from the currently held modifiers.
            Volatile.Write(ref inputPointerIsPen, IsDigitizer(data) ? 1 : 0);
            Volatile.Write(ref contactX, data.Position.X);
            Volatile.Write(ref contactY, data.Position.Y);
            Volatile.Write(ref contactValid, 1);
            if (mode == INPUT_PICK || mode == INPUT_PAN)
            {
                if (Volatile.Read(ref overlayPointerStream) != 0)
                    return CallNextHookEx(hookHandle, code, wParam, lParam);
                if (mode == INPUT_PICK || mode == INPUT_PAN)
                    EmitPointer("CANCEL", data, alt, space, 0);
                SetInputMode(INPUT_NONE);
                mode = INPUT_NONE;
            }
            else if (mode != INPUT_NONE)
            {
                SetInputMode(INPUT_NONE);
                mode = INPUT_NONE;
            }
            if (alt)
            {
                SetInputMode(INPUT_PICK);
                EmitPointer("DOWN", data, true, space, 0);
                EmitPointer("MOVE", data, true, space, 0);
            }
            else if (space)
            {
                SetInputMode(INPUT_PAN);
                EmitPointer("DOWN", data, false, true, 0);
                EmitPointer("MOVE", data, false, true, 0);
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
            else if (mode == INPUT_BLOCK && alt)
            {
                // Short taps often have no MOVE packet, so the delayed-Alt
                // promotion on MOVE never runs. Replay the contact as a pick
                // so a click still reaches the frontend.
                EmitPointer("DOWN", data, true, space, 0);
                EmitPointer("MOVE", data, true, space, 0);
                EmitPointer("UP", data, true, space, 0);
            }
            SetInputMode(INPUT_NONE);
            return CallNextHookEx(hookHandle, code, wParam, lParam);
        }

        if (message == WM_RBUTTONDOWN && inside && mode == INPUT_NONE)
        {
            Volatile.Write(ref suppressRightUntilUp, 1);
            if (Interlocked.CompareExchange(ref rightMoveActive, 1, 0) == 0)
            {
                var moveHandle = window.ToInt64();
                var moveThread = new Thread(delegate()
                {
                    try
                    {
                        Begin(moveHandle);
                        Emit("DONE");
                    }
                    finally
                    {
                        Volatile.Write(ref rightMoveActive, 0);
                    }
                });
                moveThread.IsBackground = true;
                moveThread.Name = "Yoiniwa collaboration right move";
                moveThread.Start();
            }
            // This is the sole LL mouse suppression: it preserves Yoiniwa's
            // right-button move without opening a Photoshop context menu.
            return new IntPtr(1);
        }
        if (message == WM_RBUTTONUP && Volatile.Read(ref suppressRightUntilUp) != 0)
        {
            Volatile.Write(ref suppressRightUntilUp, 0);
            return new IntPtr(1);
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
        if (code < 0 || Volatile.Read(ref inputEnabled) == 0)
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);

        var message = wParam.ToInt32();
        var keyDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        var keyUp = message == WM_KEYUP || message == WM_SYSKEYUP;
        if (!keyDown && !keyUp)
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);

        var data = (KeyboardHookData)Marshal.PtrToStructure(lParam, typeof(KeyboardHookData));
        var isAlt = data.VirtualKey == VK_MENU || data.VirtualKey == VK_LMENU || data.VirtualKey == VK_RMENU;
        if (isAlt)
        {
            Volatile.Write(ref altKeyDown, keyDown ? 1 : 0);
            if (keyDown) PromoteBlockedGesture(true);
            else EmitIdleHoverEnd();
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);
        }
        if (data.VirtualKey == VK_SPACE)
        {
            Volatile.Write(ref spaceKeyDown, keyDown ? 1 : 0);
            if (keyDown) PromoteBlockedGesture(false);
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);
        }
        if (!keyDown || Volatile.Read(ref collaborationZoomEnabled) == 0
            || Volatile.Read(ref inputMode) != INPUT_NONE)
            return CallNextHookEx(keyboardHookHandle, code, wParam, lParam);

        var zoomIn = data.VirtualKey == VK_ADD || data.VirtualKey == VK_OEM_PLUS;
        var zoomOut = data.VirtualKey == VK_SUBTRACT || data.VirtualKey == VK_OEM_MINUS;
        if ((!zoomIn && !zoomOut) || !IsKeyDown(VK_CONTROL) || IsAltDown())
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
        // Without matching this thread's DPI context, visible bounds are
        // virtualized and edge contacts are mistaken for outside.
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

    // Must run before the helper process dies. Killing PowerShell while WH_MOUSE_LL
    // is installed can leave callbacks racing with a reused HWND. No shutdown path
    // injects a synthetic button-up; it only releases our own Hook and HWND.
    public static void ShutdownInputHooks()
    {
        ShutdownInputHooks(false);
    }

    public static void ShutdownInputHooks(bool force)
    {
        Volatile.Write(ref inputEnabled, 0);
        Interlocked.Exchange(ref inputWindowHandle, 0);
        Volatile.Write(ref altKeyDown, 0);
        Volatile.Write(ref spaceKeyDown, 0);
        Volatile.Write(ref suppressRightUntilUp, 0);
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
        Volatile.Write(ref hookPhysicalCoordinatesReady, 0);
        HookStarted.Reset();
        try { Emit("INPUT_SHUTDOWN"); } catch { }
    }

    public static bool ConfigureInput(long rawHandle, bool enabled, bool enableCollaborationZoom)
    {
        if (!enabled)
        {
            if (Volatile.Read(ref inputMode) != INPUT_NONE || IsKeyDown(VK_LBUTTON)
                || Volatile.Read(ref rightMoveActive) != 0 || Volatile.Read(ref suppressRightUntilUp) != 0)
                return false;
            // Idempotent fast path: shortcut exit + set_mode both disable once.
            var alive = false;
            lock (HookLock) { alive = hookThread != null && hookThread.IsAlive; }
            if (Volatile.Read(ref inputEnabled) == 0 && !alive && hookHandle == IntPtr.Zero)
                return true;
            ShutdownInputHooks(false);
            return true;
        }
        if (IsKeyDown(VK_LBUTTON) || IsKeyDown(VK_RBUTTON)) return false;
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
        InvalidateHitBounds();
        Volatile.Write(ref altKeyDown, IsKeyDown(VK_MENU) ? 1 : 0);
        Volatile.Write(ref spaceKeyDown, IsKeyDown(VK_SPACE) ? 1 : 0);
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
        try { [RefCanvasNativeWindowMove]::ShutdownInputLayer() } catch { }
    })
} catch { }

try {
while (($line = [Console]::In.ReadLine()) -ne $null) {
    try {
        $parts = $line.Split('|')
        if ($parts[0] -eq 'SHUTDOWN') {
            [RefCanvasNativeWindowMove]::ShutdownInputHooks($true)
            [RefCanvasNativeWindowMove]::ShutdownInputLayer()
            [Console]::Out.WriteLine('SHUTDOWN_ACK')
            [Console]::Out.Flush()
            break
        } elseif (($parts.Length -eq 4 -or $parts.Length -eq 5) -and $parts[0] -eq 'INPUT') {
            $enabled = $parts[3] -eq '1'
            $enableCollaborationZoom = $parts.Length -eq 5 -and $parts[4] -eq '1'
            $applied = [RefCanvasNativeWindowMove]::ConfigureInput([long]::Parse($parts[2]), $enabled, $enableCollaborationZoom)
            [Console]::Out.WriteLine('INPUT_ACK|' + $parts[1] + '|' + $(if (!$applied) { 'FAILED' } elseif ($enabled) { 'READY' } else { 'RELEASED' }))
        } elseif ($parts.Length -eq 4 -and $parts[0] -eq 'LAYER') {
            $status = [RefCanvasNativeWindowMove]::ConfigureInputLayer([long]::Parse($parts[2]), $parts[3] -eq '1')
            [Console]::Out.WriteLine('LAYER_ACK|' + $parts[1] + '|' + $status)
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
    try { [RefCanvasNativeWindowMove]::ShutdownInputHooks($true) } catch { }
    try { [RefCanvasNativeWindowMove]::ShutdownInputLayer() } catch { }
}
