import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { ColorPickerShortcut } from '../../interactions';
import {
  DEFAULT_SHORTCUTS,
  loadShortcutPreferences,
  PAN_MOUSE_MIDDLE_SHORTCUT,
  panModifierShortcutFromKeyboardEvent,
  panShortcutFromKeyboardEvent,
  SHORTCUT_LABELS,
  shortcutConflict,
  shortcutFromKeyboardEvent,
  SHORTCUT_PREFERENCES_STORAGE_KEY,
  type ShortcutId,
  type ShortcutPreferences,
} from '../../keyboardShortcuts';
import type { CacheInfo } from '../../types';

const COLOR_PICKER_SHORTCUT_STORAGE_KEY = 'refcanvas.colorPickerShortcut';

interface UseAppPreferencesOptions {
  api: Window['refCanvas'];
  drawingCollaborationModeRef: { current: boolean };
  setStatus(message: string): void;
}

export function useAppPreferences({ api, drawingCollaborationModeRef, setStatus }: UseAppPreferencesOptions) {
  const [cacheInfo, setCacheInfo] = useState<CacheInfo>();
  const [cacheChanging, setCacheChanging] = useState(false);
  const [colorPickerShortcut] = useState<ColorPickerShortcut>(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.has('smoke') || query.has('stress')) return 's';
    try { return localStorage.getItem(COLOR_PICKER_SHORTCUT_STORAGE_KEY) === 'alt' ? 'alt' : 's'; }
    catch { return 's'; }
  });
  const [shortcuts, setShortcuts] = useState<ShortcutPreferences>(() => {
    try { return loadShortcutPreferences(localStorage.getItem(SHORTCUT_PREFERENCES_STORAGE_KEY)); }
    catch { return { ...DEFAULT_SHORTCUTS }; }
  });
  const [shortcutCaptureId, setShortcutCaptureId] = useState<ShortcutId>();

  useEffect(() => {
    try { localStorage.setItem(COLOR_PICKER_SHORTCUT_STORAGE_KEY, colorPickerShortcut); }
    catch { /* Persistence is optional. */ }
  }, [colorPickerShortcut]);

  useEffect(() => {
    try { localStorage.setItem(SHORTCUT_PREFERENCES_STORAGE_KEY, JSON.stringify(shortcuts)); }
    catch { /* Persistence is optional. */ }
  }, [shortcuts]);

  useEffect(() => {
    if (!api) return;
    void api.getCollaborationShortcut()
      .then(({ shortcut }) => setShortcuts((current) => ({ ...current, collaboration: shortcut })))
      .catch((error) => setStatus(`读取协作快捷键失败：${String(error)}`));
    void api.getCacheInfo().then(setCacheInfo)
      .catch((error) => setStatus(`读取缓存状态失败：${String(error)}`));
  }, [api, setStatus]);

  const commitPanCanvasShortcut = useCallback((next: string) => {
    if (next === 'Alt' && colorPickerShortcut === 'alt') {
      setStatus('Alt 当前用于取色，请为拖动画布设置其他快捷键');
      return;
    }
    const conflict = shortcutConflict(shortcuts, 'panCanvas', next);
    if (conflict) { setStatus(`快捷键 ${next} ${conflict}`); return; }
    setShortcuts((current) => ({ ...current, panCanvas: next }));
    setShortcutCaptureId(undefined);
    setStatus(`拖动画布快捷键已设为 ${next === PAN_MOUSE_MIDDLE_SHORTCUT ? '鼠标中键' : next}`);
  }, [colorPickerShortcut, setStatus, shortcuts]);

  const captureShortcut = useCallback((id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setShortcutCaptureId(undefined);
      setStatus('已取消快捷键设置');
      return;
    }
    if (id === 'panCanvas') {
      const modifier = panModifierShortcutFromKeyboardEvent(event.nativeEvent);
      if (modifier) {
        setStatus(`继续按下其他按键可设置组合键，松开将使用 ${modifier}`);
        return;
      }
      const next = panShortcutFromKeyboardEvent(event.nativeEvent);
      if (!next) { setStatus('请按下一个有效的快捷键组合'); return; }
      commitPanCanvasShortcut(next);
      return;
    }
    const next = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!next) { setStatus('请按下一个有效的快捷键组合'); return; }
    if (id !== 'collaboration' && next.split('+').includes('Alt')) {
      setStatus('Alt 组合键保留给取色与画布交互');
      return;
    }
    const conflict = shortcutConflict(shortcuts, id, next);
    if (conflict) { setStatus(`快捷键 ${next} ${conflict}`); return; }
    if (id === 'collaboration') {
      if (drawingCollaborationModeRef.current) {
        setStatus('请先退出协作模式，再更改协作快捷键');
        setShortcutCaptureId(undefined);
        return;
      }
      if (!api) {
        setStatus('桌面快捷键服务不可用');
        setShortcutCaptureId(undefined);
        return;
      }
      void api.setCollaborationShortcut(next).then((result) => {
        if (!result.ok) { setStatus(result.message ?? '协作快捷键注册失败'); return; }
        setShortcuts((current) => ({ ...current, collaboration: result.shortcut }));
        setShortcutCaptureId(undefined);
        setStatus(`协作快捷键已设为 ${result.shortcut}`);
      }).catch((error) => setStatus(`设置协作快捷键失败：${String(error)}`));
      return;
    }
    setShortcuts((current) => ({ ...current, [id]: next }));
    setShortcutCaptureId(undefined);
    setStatus(`${SHORTCUT_LABELS.find((item) => item.id === id)?.label ?? '操作'}快捷键已设为 ${next}`);
  }, [api, commitPanCanvasShortcut, drawingCollaborationModeRef, setStatus, shortcuts]);

  const capturePanShortcutKeyUp = useCallback((id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (id !== 'panCanvas' || shortcutCaptureId !== id) return;
    const modifier = panModifierShortcutFromKeyboardEvent(event.nativeEvent);
    if (!modifier) return;
    event.preventDefault();
    event.stopPropagation();
    commitPanCanvasShortcut(modifier);
  }, [commitPanCanvasShortcut, shortcutCaptureId]);

  const capturePanShortcutMouse = useCallback((id: ShortcutId, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (id !== 'panCanvas' || shortcutCaptureId !== id || event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    commitPanCanvasShortcut(PAN_MOUSE_MIDDLE_SHORTCUT);
  }, [commitPanCanvasShortcut, shortcutCaptureId]);

  const resetShortcuts = useCallback(() => {
    if (drawingCollaborationModeRef.current) { setStatus('请先退出协作模式，再恢复快捷键'); return; }
    if (!api) {
      setShortcuts({ ...DEFAULT_SHORTCUTS });
      setShortcutCaptureId(undefined);
      setStatus('快捷键已恢复默认');
      return;
    }
    void api.setCollaborationShortcut(DEFAULT_SHORTCUTS.collaboration).then((result) => {
      if (!result.ok) { setStatus(result.message ?? '恢复协作快捷键失败'); return; }
      setShortcuts({ ...DEFAULT_SHORTCUTS, collaboration: result.shortcut });
      setShortcutCaptureId(undefined);
      setStatus('快捷键已恢复默认');
    }).catch((error) => setStatus(`恢复快捷键失败：${String(error)}`));
  }, [api, drawingCollaborationModeRef, setStatus]);

  const beginShortcutCapture = useCallback((id: ShortcutId, label: string) => {
    setShortcutCaptureId(id);
    setStatus(`请按下“${label}”的新快捷键`);
  }, [setStatus]);

  const chooseCacheLocation = useCallback(() => {
    if (!api) return;
    void (async () => {
      setCacheChanging(true);
      try {
        const result = await api.chooseCacheLocation();
        if (!result.canceled && result.info) {
          setCacheInfo(result.info);
          setStatus('缓存已迁移到新位置');
        }
      } catch (error) { setStatus(`迁移缓存失败：${String(error)}`); }
      finally { setCacheChanging(false); }
    })();
  }, [api, setStatus]);

  const resetCacheLocation = useCallback(() => {
    if (!api) return;
    void (async () => {
      setCacheChanging(true);
      try {
        setCacheInfo(await api.resetCacheLocation());
        setStatus('缓存已恢复默认位置');
      } catch (error) { setStatus(`迁移缓存失败：${String(error)}`); }
      finally { setCacheChanging(false); }
    })();
  }, [api, setStatus]);

  const clearCache = useCallback(() => {
    if (!api) return;
    void (async () => {
      setCacheChanging(true);
      try {
        setCacheInfo(await api.clearCache());
        setStatus('预览缓存已清除，需要时将自动重新生成');
      } catch (error) { setStatus(`清除缓存失败：${String(error)}`); }
      finally { setCacheChanging(false); }
    })();
  }, [api, setStatus]);

  const openLogsFolder = useCallback(() => {
    if (!api) return;
    void api.openLogsFolder().then((result) => setStatus(`日志目录：${result.path}`))
      .catch((error) => setStatus(`打开日志目录失败：${String(error)}`));
  }, [api, setStatus]);

  const copyDiagnostics = useCallback(() => {
    if (!api) return;
    void api.copyDiagnostics().then((result) => setStatus(`诊断信息已复制 · 会话 ${result.sessionId.slice(0, 8)}`))
      .catch((error) => setStatus(`复制诊断信息失败：${String(error)}`));
  }, [api, setStatus]);

  return {
    cacheInfo,
    cacheChanging,
    colorPickerShortcut,
    shortcuts,
    shortcutCaptureId,
    setShortcutCaptureId,
    captureShortcut,
    capturePanShortcutKeyUp,
    capturePanShortcutMouse,
    resetShortcuts,
    beginShortcutCapture,
    chooseCacheLocation,
    resetCacheLocation,
    clearCache,
    openLogsFolder,
    copyDiagnostics,
  };
}
