import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldAutoPhotoshopRoundTrip } from '../../shared/photoshopIntegration';
import type { WindowState } from '../../types';
import { logError, logInfo, logWarn } from '../../logger';

const initialWindowState: WindowState = {
  alwaysOnTop: false,
  clickThrough: false,
  locked: false,
  collaborationMode: false,
  opacity: 1,
};

interface UseWindowCollaborationControllerOptions {
  api: Window['refCanvas'];
  collaborationShortcut: string;
  onLockedRef: { current: () => void };
  setStatus(message: string): void;
}

export function useWindowCollaborationController({
  api,
  collaborationShortcut,
  onLockedRef,
  setStatus,
}: UseWindowCollaborationControllerOptions) {
  const [mode, setModeState] = useState(initialWindowState);
  const [drawingCollaborationMode, setDrawingCollaborationMode] = useState(false);
  const drawingModeSnapshotRef = useRef<{ locked: boolean; alwaysOnTop: boolean } | undefined>(undefined);

  const setMode = useCallback(async (patch: Partial<WindowState>, force = false) => {
    if (!api) return undefined;
    const protectedPatch = !force && drawingCollaborationMode
      && ('locked' in patch || 'alwaysOnTop' in patch || 'collaborationMode' in patch)
      ? { ...patch, locked: true, alwaysOnTop: true, collaborationMode: true }
      : patch;
    try {
      const next = await api.setWindowMode(protectedPatch);
      setModeState(next);
      if (next.locked) {
        onLockedRef.current();
        setStatus(shouldAutoPhotoshopRoundTrip(next)
          ? '无感取色已启用 · Photoshop 保持前台，Alt + 笔尖直接取色'
          : '参考模式已锁定 · 同时开启始终置顶后可启用 Photoshop 无焦点取色');
      } else if (patch.locked === false) {
        setStatus('画板已解锁');
      }
      return next;
    } catch (error) {
      setStatus(`窗口模式切换失败：${error instanceof Error ? error.message : String(error)}`);
      logWarn('window.set_mode_failed', { error: String(error), patch: protectedPatch });
      throw error;
    }
  }, [api, drawingCollaborationMode, onLockedRef, setStatus]);

  const toggleDrawingCollaborationMode = useCallback(async () => {
    if (!api) return;
    if (drawingCollaborationMode) {
      const snapshot = drawingModeSnapshotRef.current;
      drawingModeSnapshotRef.current = undefined;
      try {
        const next = await setMode({
          ...(snapshot ?? { locked: false, alwaysOnTop: false }),
          collaborationMode: false,
        }, true);
        if (next?.collaborationMode) throw new Error('窗口层级仍在恢复中');
        setDrawingCollaborationMode(false);
        logInfo('collaboration.disabled');
        setStatus('已退出协作模式，窗口状态已恢复');
      } catch (error) {
        drawingModeSnapshotRef.current = snapshot;
        logError('collaboration.disable_failed', error);
        setStatus(`退出协作模式失败：${String(error)}`);
      }
      return;
    }
    const snapshot = { locked: mode.locked, alwaysOnTop: mode.alwaysOnTop };
    try {
      const next = await setMode({ locked: true, alwaysOnTop: true, collaborationMode: true }, true);
      if (!next?.collaborationMode) throw new Error('未能确认任务栏后方的稳定协作窗口层级');
      drawingModeSnapshotRef.current = snapshot;
      setDrawingCollaborationMode(true);
      logInfo('collaboration.enabled', { shortcut: collaborationShortcut });
      setStatus(`协作模式已启用 · Space + 主按钮拖动可平移画布 · ${collaborationShortcut} 退出`);
    } catch (error) {
      drawingModeSnapshotRef.current = undefined;
      logError('collaboration.enable_failed', error);
      setStatus(`启用协作模式失败：${String(error)}`);
    }
  }, [api, collaborationShortcut, drawingCollaborationMode, mode.alwaysOnTop, mode.locked, setMode, setStatus]);

  useEffect(() => {
    if (!api) return undefined;
    void api.getWindowMode().then(setModeState)
      .catch((error) => setStatus(`读取窗口状态失败：${String(error)}`));
    return api.onClickThroughDisabled(() => {
      setModeState((value) => ({ ...value, clickThrough: false }));
      setStatus('鼠标穿透已通过全局快捷键关闭');
    });
  }, [api, setStatus]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onToggleCollaborationRequested(() => { void toggleDrawingCollaborationMode(); });
  }, [api, toggleDrawingCollaborationMode]);

  return {
    mode,
    drawingCollaborationMode,
    autoPhotoshopRoundTrip: shouldAutoPhotoshopRoundTrip(mode),
    documentBlocked: drawingCollaborationMode || (mode.locked && mode.alwaysOnTop),
    setMode,
    toggleDrawingCollaborationMode,
  };
}
