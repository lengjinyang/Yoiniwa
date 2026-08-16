import { useCallback, useRef } from 'react';
import { captureSceneSelection, pasteScenePayload, type SceneClipboardPayload } from '../../domain/sceneClipboard';
import type { ImageGroup } from '../../types';
import type { SceneHistoryController } from './useSceneHistory';

export function useSceneClipboard({
  history,
  selectedIds,
  selectedGroupId,
  selectedGroup,
  lastPointerRef,
  setSelectedIds,
  setSelectedGroupId,
  deleteSelected,
  deleteGroup,
  setStatus,
}: {
  history: SceneHistoryController;
  selectedIds: string[];
  selectedGroupId?: string;
  selectedGroup?: ImageGroup;
  lastPointerRef: { current: { x: number; y: number } };
  setSelectedIds(ids: string[]): void;
  setSelectedGroupId(id?: string): void;
  deleteSelected(): void;
  deleteGroup(withContents: boolean): void;
  setStatus(message: string): void;
}) {
  const sceneClipboardRef = useRef<SceneClipboardPayload | undefined>(undefined);

  const copySelection = useCallback(() => {
    const payload = captureSceneSelection(history.scene, selectedIds, selectedGroupId);
    if (!payload) { setStatus('没有可复制的内容'); return false; }
    sceneClipboardRef.current = payload;
    setStatus(selectedGroupId ? '已复制分组框及其内容' : `已复制 ${payload.items.length} 项`);
    return true;
  }, [history.scene, selectedGroupId, selectedIds, setStatus]);

  const cutSelection = useCallback(() => {
    if (!copySelection()) return;
    if (selectedGroup) deleteGroup(true);
    else deleteSelected();
    setStatus('已剪切，按 Ctrl+V 粘贴');
  }, [copySelection, deleteGroup, deleteSelected, selectedGroup, setStatus]);

  const pasteClipboard = useCallback(() => {
    const payload = sceneClipboardRef.current;
    if (!payload) { setStatus('内部剪贴板为空'); return; }
    const next = structuredClone(history.scene);
    const pointer = lastPointerRef.current;
    const viewport = history.scene.viewport;
    const result = pasteScenePayload(next, payload, {
      x: (pointer.x - viewport.x) / viewport.scale,
      y: (pointer.y - viewport.y) / viewport.scale,
    });
    history.commit((scene) => {
      scene.items = next.items;
      scene.groups = next.groups;
      scene.visualNotes = next.visualNotes;
    });
    setSelectedIds(result?.rootGroupId ? [] : result?.imageIds ?? []);
    setSelectedGroupId(result?.rootGroupId);
    setStatus(result?.rootGroupId ? '已粘贴完整分组框' : '已粘贴内容');
  }, [history, lastPointerRef, setSelectedGroupId, setSelectedIds, setStatus]);

  return {
    copySelection,
    cutSelection,
    pasteClipboard,
    hasClipboard: Boolean(sceneClipboardRef.current),
  };
}
