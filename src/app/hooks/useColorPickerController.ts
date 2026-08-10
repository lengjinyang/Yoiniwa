import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColorPickerShortcut } from '../../interactions';
import type { PickedColor } from '../../types';
import { logWarn } from '../../logger';

interface UseColorPickerControllerOptions {
  api: Window['refCanvas'];
  colorPickerShortcut: ColorPickerShortcut;
  autoPhotoshopRoundTrip: boolean;
  drawingCollaborationMode: boolean;
  windowLocked: boolean;
  setStatus(message: string): void;
}

export function useColorPickerController({
  api,
  colorPickerShortcut,
  autoPhotoshopRoundTrip,
  drawingCollaborationMode,
  windowLocked,
  setStatus,
}: UseColorPickerControllerOptions) {
  const [held, setHeld] = useState(false);
  const colorSyncRequestRef = useRef(0);

  useEffect(() => {
    setHeld(false);
  }, [colorPickerShortcut]);

  const syncPickedColor = useCallback(async (color: PickedColor) => {
    const request = ++colorSyncRequestRef.current;
    if (!api) {
      setStatus(`无法连接桌面取色服务 ${color.hex}`);
      return;
    }
    const result = await api.syncPhotoshopForeground(
      color,
      // Collaboration must never request a focus round-trip; Photoshop keeps Ink ownership.
      drawingCollaborationMode ? false : autoPhotoshopRoundTrip,
    );
    if (request !== colorSyncRequestRef.current) return;
    if (!result.ok) {
      logWarn('photoshop.sync_failed', { hex: color.hex, status: result.status, message: result.message, copied: result.copied });
      setStatus(`${result.message ?? 'Photoshop 同步失败'} · ${color.hex}`);
      return;
    }
    if (drawingCollaborationMode) return;
    setStatus(result.focusStatus === 'automation-error' || result.focusStatus === 'not-found'
      ? `已同步 Photoshop 前景色，但未能自动返回窗口 · ${color.hex}`
      : `已同步 Photoshop 前景色 ${color.hex}`);
  }, [api, autoPhotoshopRoundTrip, drawingCollaborationMode, setStatus]);

  return {
    held,
    setHeld,
    activeShortcut: windowLocked ? 'alt' as const : colorPickerShortcut,
    syncPickedColor,
  };
}
