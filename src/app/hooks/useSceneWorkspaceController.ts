import { useCallback, useMemo, useState } from 'react';
import type { LassoPoint } from '../../canvas/selection/SelectionController';
import {
  memberBounds,
  reconcileMemberBounds,
  resetNonDestructiveCrop,
} from '../../domain/scene';
import { captureSceneSelection, pasteScenePayload } from '../../domain/sceneClipboard';
import { deleteSceneSelection } from '../../domain/sceneCommands';
import type { ImageGroup, SceneItem } from '../../types';
import type { SceneHistoryController } from '../../useSceneHistory';
import { useSceneClipboard } from './useSceneClipboard';
import { useSceneGroups } from './useSceneGroups';
import { useSceneViewport } from './useSceneViewport';

interface UseSceneWorkspaceControllerOptions {
  api: Window['refCanvas'];
  history: SceneHistoryController;
  windowLocked: boolean;
  closeContextMenu(): void;
  lastPointerRef: { current: { x: number; y: number } };
  setStatus(message: string): void;
}

export function useSceneWorkspaceController({
  api,
  history,
  windowLocked,
  closeContextMenu,
  lastPointerRef,
  setStatus,
}: UseSceneWorkspaceControllerOptions) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [lassoPoints, setLassoPoints] = useState<LassoPoint[]>();
  const [lassoClearRequest, setLassoClearRequest] = useState(0);

  const selectedItems = useMemo(() => selectedIds.flatMap((id) => {
    const item = history.scene.items.find((value) => value.id === id);
    return item ? [item] : [];
  }), [history.scene.items, selectedIds]);
  const selectedGroup = selectedGroupId
    ? history.scene.groups.find((group) => group.id === selectedGroupId)
    : undefined;
  const targetIds = useMemo(() => {
    if (selectedIds.length) {
      return selectedIds.filter((id) => !history.scene.items.find((item) => item.id === id)?.locked);
    }
    if (selectedGroup) {
      const ids: string[] = [];
      const visited = new Set<string>();
      const collect = (group: ImageGroup) => {
        if (visited.has(group.id)) return;
        visited.add(group.id);
        group.members.forEach((member) => {
          if (member.type === 'image' && !history.scene.items.find((item) => item.id === member.id)?.locked) ids.push(member.id);
          if (member.type === 'group') {
            const child = history.scene.groups.find((value) => value.id === member.id);
            if (child) collect(child);
          }
        });
      };
      collect(selectedGroup);
      return [...new Set(ids)];
    }
    return history.scene.items.filter((item) => !item.locked).map((item) => item.id);
  }, [history.scene.groups, history.scene.items, selectedGroup, selectedIds]);
  const primary = selectedItems[0];
  const hasContent = history.scene.items.length > 0 || history.scene.groups.length > 0;

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setSelectedGroupId(undefined);
  }, []);

  const selectAll = useCallback(() => {
    if (windowLocked) return;
    setSelectedGroupId(undefined);
    setSelectedIds(history.scene.items.filter((item) => !item.locked).map((item) => item.id));
  }, [history.scene.items, windowLocked]);

  const onSelectionChange = useCallback((ids: string[], source?: 'lasso' | string) => {
    setSelectedIds(ids);
    setSelectedGroupId(undefined);
    if (source !== 'lasso') setLassoPoints(undefined);
  }, []);

  const onGroupSelectionChange = useCallback((id?: string) => {
    setSelectedGroupId(id);
    if (id) setSelectedIds([]);
  }, []);

  const mutateSelected = useCallback((updater: (item: SceneItem) => void) => {
    if (!selectedIds.length) return;
    const selected = new Set(selectedIds);
    history.commit((scene) => {
      scene.items.forEach((item) => {
        if (!selected.has(item.id)) return;
        updater(item);
        const bounds = memberBounds(scene, { type: 'image', id: item.id });
        if (bounds) reconcileMemberBounds(scene, { type: 'image', id: item.id }, bounds);
      });
    });
  }, [history, selectedIds]);

  const previewSelected = useCallback((updater: (item: SceneItem) => void) => {
    if (!selectedIds.length) return;
    const selected = new Set(selectedIds);
    history.preview((scene) => {
      scene.items.forEach((item) => { if (selected.has(item.id)) updater(item); });
    });
  }, [history, selectedIds]);

  const beginSelectedAdjustment = useCallback(() => {
    if (selectedIds.length) history.beginTransaction();
  }, [history, selectedIds.length]);

  const commitSelectedAdjustment = useCallback(() => {
    if (selectedIds.length) history.commitTransaction();
  }, [history, selectedIds.length]);

  const restoreFullImages = useCallback(() => {
    const cropped = selectedItems.filter((item) => item.crop.x !== 0 || item.crop.y !== 0
      || item.crop.width !== item.naturalWidth || item.crop.height !== item.naturalHeight);
    if (!cropped.length) { setStatus('选中图片当前已经是完整原图'); return; }
    mutateSelected(resetNonDestructiveCrop);
    setStatus(`已恢复 ${cropped.length} 张图片被裁掉的区域`);
  }, [mutateSelected, selectedItems, setStatus]);

  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    history.commit((scene) => deleteSceneSelection(scene, selectedIds));
    setSelectedIds([]);
  }, [history, selectedIds]);

  const duplicate = useCallback(() => {
    const payload = captureSceneSelection(history.scene, selectedIds, selectedGroupId);
    if (!payload) return;
    const next = structuredClone(history.scene);
    const result = pasteScenePayload(next, payload, 30);
    history.commit((scene) => {
      scene.items = next.items;
      scene.groups = next.groups;
      scene.visualNotes = next.visualNotes;
    });
    setSelectedIds(result?.rootGroupId ? [] : result?.imageIds ?? []);
    setSelectedGroupId(result?.rootGroupId);
  }, [history, selectedGroupId, selectedIds]);

  const groups = useSceneGroups({
    history,
    selectedIds,
    selectedGroup,
    selectedGroupId,
    setSelectedIds,
    setSelectedGroupId,
    closeContextMenu,
    setStatus,
  });
  const clipboard = useSceneClipboard({
    history,
    selectedIds,
    selectedGroupId,
    selectedGroup,
    lastPointerRef,
    setSelectedIds,
    setSelectedGroupId,
    deleteSelected,
    deleteGroup: groups.deleteGroup,
    setStatus,
  });
  const viewport = useSceneViewport({
    history,
    windowLocked,
    selectedIds,
    targetIds,
    primary,
    setSelectedIds,
    setSelectedGroupId,
  });

  const showPrimarySource = useCallback(async () => {
    if (!primary?.sourcePath) { setStatus('这张图片来自剪贴板，或没有可用的本地源文件'); return; }
    const result = await api?.showSourceInFolder(primary.sourcePath);
    setStatus(result?.ok ? '已在资源管理器中定位源文件' : result?.message ?? '无法打开源文件位置');
  }, [api, primary, setStatus]);

  return {
    selectedIds,
    setSelectedIds,
    selectedGroupId,
    setSelectedGroupId,
    selectedItems,
    selectedGroup,
    primary,
    targetIds,
    hasContent,
    lassoPoints,
    setLassoPoints,
    lassoClearRequest,
    clearLasso: () => {
      setLassoPoints(undefined);
      setLassoClearRequest((request) => request + 1);
    },
    clearSelection,
    selectAll,
    onSelectionChange,
    onGroupSelectionChange,
    mutateSelected,
    previewSelected,
    beginSelectedAdjustment,
    commitSelectedAdjustment,
    restoreFullImages,
    deleteSelected,
    duplicate,
    ...groups,
    ...clipboard,
    showPrimarySource,
    ...viewport,
  };
}
