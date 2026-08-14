import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { ColorPickerShortcut } from '../../interactions';
import {
  DEFAULT_SHORTCUTS,
  loadShortcutPreferences,
  panModifierShortcutFromKeyboardEvent,
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
  const [shortcuts, setShortcuts] = useState<ShortcutPreferences>(() => {
    try {
      const raw = localStorage.getItem(SHORTCUT_PREFERENCES_STORAGE_KEY);
      const values = loadShortcutPreferences(raw);
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
      if (typeof parsed?.colorPicker !== 'string'
        && localStorage.getItem(COLOR_PICKER_SHORTCUT_STORAGE_KEY) === 'alt') values.colorPicker = 'Alt';
      const query = new URLSearchParams(window.location.search);
      if (query.has('smoke') || query.has('stress')) values.colorPicker = 'S';
      return values;
    }
    catch { return { ...DEFAULT_SHORTCUTS }; }
  });
  const [shortcutCaptureId, setShortcutCaptureId] = useState<ShortcutId>();
  const colorPickerShortcut: ColorPickerShortcut = shortcuts.colorPicker === 'Alt' ? 'alt' : 's';

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

  const commitShortcut = useCallback((id: ShortcutId, next: string) => {
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
        setStatus(`协作模式快捷键已设为 ${result.shortcut}`);
      }).catch((error) => setStatus(`设置协作快捷键失败：${String(error)}`));
      return;
    }
    setShortcuts((current) => ({ ...current, [id]: next }));
    setShortcutCaptureId(undefined);
    const label = SHORTCUT_LABELS.find((item) => item.id === id)?.label ?? '操作';
    setStatus(`${label}快捷键已设为 ${next}`);
  }, [api, drawingCollaborationModeRef, setStatus, shortcuts]);

  const captureShortcut = useCallback((id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const modifier = panModifierShortcutFromKeyboardEvent(event.nativeEvent);
    if (modifier) {
      setStatus(`继续按下其他按键可设置组合键，松开将使用 ${modifier}`);
      return;
    }
    const next = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!next) { setStatus('请按下一个有效的快捷键组合'); return; }
    commitShortcut(id, next);
  }, [commitShortcut, setStatus]);

  const captureShortcutKeyUp = useCallback((id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (shortcutCaptureId !== id) return;
    const modifier = panModifierShortcutFromKeyboardEvent(event.nativeEvent);
    if (!modifier) return;
    event.preventDefault();
    event.stopPropagation();
    commitShortcut(id, modifier);
  }, [commitShortcut, shortcutCaptureId]);

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
    captureShortcutKeyUp,
    resetShortcuts,
    beginShortcutCapture,
    chooseCacheLocation,
    resetCacheLocation,
    clearCache,
    openLogsFolder,
    copyDiagnostics,
  };
}
