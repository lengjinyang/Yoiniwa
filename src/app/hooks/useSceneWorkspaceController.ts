import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LassoPoint } from '../../canvas/selection/SelectionController';
import type { ColorControlHandle } from '../../ColorControl';
import { applyLayout, type LayoutAction } from '../../layout';
import { MAX_ZOOM, MIN_ZOOM } from '../../interactions';
import {
  addMemberToGroup,
  createGroupFrame,
  detachImageFromGroup,
  fitAutoGroupsToContents,
  fitGroupToContents,
  groupVisibleBounds,
  itemBounds,
  memberBounds,
  moveGroupWithContents,
  reconcileAllMemberships,
  reconcileMemberBounds,
  reorderImages,
  resetNonDestructiveCrop,
  sceneBounds,
} from '../../scene';
import { captureSceneSelection, pasteScenePayload, type SceneClipboardPayload } from '../../sceneClipboard';
import { applyImageChanges, deleteSceneSelection, layoutSceneImages, moveImageLayer } from '../../domain/sceneCommands';
import type { GroupFrameBounds } from '../../canvas/selection/GroupResizeController';
import type { ImageGroup, ImageItem } from '../../types';
import type { SceneHistoryController } from '../../useSceneHistory';
import type { MenuPosition } from '../../ContextMenu';

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
  const [renamingGroupId, setRenamingGroupId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [groupActionMenu, setGroupActionMenu] = useState<{ id: string; position: MenuPosition }>();
  const [groupColorEditor, setGroupColorEditor] = useState<{ id: string; anchor: { x: number; y: number } }>();
  const [focusReturn, setFocusReturn] = useState<typeof history.scene.viewport>();
  const groupColorEditorRef = useRef<ColorControlHandle>(null);
  const groupColorEditorIdRef = useRef<string | undefined>(undefined);
  const sceneClipboardRef = useRef<SceneClipboardPayload | undefined>(undefined);

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

  const mutateSelected = useCallback((updater: (item: ImageItem) => void) => {
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

  const previewSelected = useCallback((updater: (item: ImageItem) => void) => {
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

  const createGroup = useCallback(() => {
    const members = selectedIds.map((id) => ({ type: 'image' as const, id }));
    if (members.length < 2) { setStatus('请先框选至少两个对象'); return; }
    const name = `组 ${history.scene.groups.length + 1}`;
    const id = crypto.randomUUID();
    history.commit((scene) => { createGroupFrame(scene, members, name, id); });
    setSelectedIds([]);
    setSelectedGroupId(id);
    setStatus(`已创建分组框“${name}”`);
  }, [history, selectedIds, setStatus]);

  const renameGroupById = useCallback((groupId: string) => {
    const current = history.scene.groups.find((group) => group.id === groupId);
    if (!current) return;
    setSelectedGroupId(groupId);
    setRenameDraft(current.name);
    setRenamingGroupId(groupId);
  }, [history.scene.groups]);

  const renameGroup = useCallback(() => {
    if (selectedGroup) renameGroupById(selectedGroup.id);
  }, [renameGroupById, selectedGroup]);

  const cancelGroupRename = useCallback(() => {
    setRenamingGroupId(undefined);
    setRenameDraft('');
  }, []);

  const finishGroupRename = useCallback(() => {
    const name = renameDraft.trim();
    const current = renamingGroupId
      ? history.scene.groups.find((group) => group.id === renamingGroupId)
      : undefined;
    if (renamingGroupId && name && current?.name !== name) {
      history.commit((scene) => {
        const group = scene.groups.find((value) => value.id === renamingGroupId);
        if (group && group.name !== name) group.name = name;
      });
      setStatus(`分组框已重命名为“${name}”`);
    }
    setRenamingGroupId(undefined);
    setRenameDraft('');
  }, [history, renameDraft, renamingGroupId, setStatus]);

  const ungroupSelected = useCallback(() => {
    if (!selectedGroup) return;
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === selectedGroup.id);
      if (group) {
        group.members.filter((member) => member.type === 'group').forEach((member) => {
          const child = scene.groups.find((value) => value.id === member.id);
          if (child) child.parentId = undefined;
        });
        group.members = [];
      }
    });
    setStatus('已清空分组框成员');
  }, [history, selectedGroup, setStatus]);

  const detachImages = useCallback((imageIds: readonly string[], groupId?: string) => {
    const selected = new Set(imageIds);
    const targets = history.scene.groups.flatMap((group) => group.members
      .filter((member) => member.type === 'image' && selected.has(member.id) && (!groupId || group.id === groupId))
      .map((member) => ({ groupId: group.id, imageId: member.id })));
    if (!targets.length) { setStatus('选中的图片不在组内'); return; }
    history.commit((scene) => {
      targets.forEach((target) => { detachImageFromGroup(scene, target.groupId, target.imageId); });
    });
    setStatus(`已将 ${targets.length} 张图片移出组，图片位置保持不变`);
  }, [history, setStatus]);

  const detachSelectedImages = useCallback(() => detachImages(selectedIds), [detachImages, selectedIds]);

  const addImagesToGroup = useCallback((imageIds: readonly string[], groupId: string) => {
    const existingIds = new Set(history.scene.items.map((item) => item.id));
    const target = history.scene.groups.find((group) => group.id === groupId);
    const targets = [...new Set(imageIds)].filter((id) => existingIds.has(id)
      && !target?.members.some((member) => member.type === 'image' && member.id === id));
    if (!target || !targets.length) {
      setStatus(target ? '选中的图片已经在该组中' : '目标组不存在');
      return;
    }
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (!group) return;
      targets.forEach((imageId) => {
        const former = scene.groups.find((value) => value.members.some((member) =>
          member.type === 'image' && member.id === imageId));
        if (former && former.id !== group.id) detachImageFromGroup(scene, former.id, imageId);
        addMemberToGroup(scene, group, { type: 'image', id: imageId });
      });
      fitAutoGroupsToContents(scene);
    });
    setStatus(`已将 ${targets.length} 张图片加入“${target.name}”，图片位置保持不变`);
  }, [history, setStatus]);

  const changeGroup = useCallback((groupId: string, patch: Partial<ImageGroup>) => {
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (!group) return;
      Object.assign(group, patch);
      if (patch.x !== undefined || patch.y !== undefined || patch.width !== undefined || patch.height !== undefined) {
        reconcileAllMemberships(scene);
      }
    });
  }, [history]);

  const openGroupActions = useCallback((groupId: string, position: { x: number; y: number }) => {
    const group = history.scene.groups.find((value) => value.id === groupId);
    if (!group) return;
    setSelectedGroupId(groupId);
    closeContextMenu();
    setGroupActionMenu({ id: groupId, position: { x: position.x + 6, y: position.y } });
  }, [closeContextMenu, history.scene.groups]);

  useEffect(() => {
    groupColorEditorIdRef.current = groupColorEditor?.id;
  }, [groupColorEditor]);

  useEffect(() => {
    if (groupColorEditor && selectedGroupId !== groupColorEditor.id) setGroupColorEditor(undefined);
  }, [groupColorEditor, selectedGroupId]);

  const moveGroupColorEditor = useCallback((groupId: string, position: { x: number; y: number }) => {
    if (groupColorEditorIdRef.current === groupId) groupColorEditorRef.current?.setAnchor(position);
  }, []);

  const moveGroup = useCallback((groupId: string, deltaX: number, deltaY: number) => {
    if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01) return;
    history.commit((scene) => {
      moveGroupWithContents(scene, groupId, deltaX, deltaY);
      const bounds = memberBounds(scene, { type: 'group', id: groupId });
      if (bounds) reconcileMemberBounds(scene, { type: 'group', id: groupId }, bounds);
    });
  }, [history]);

  const resizeGroup = useCallback((groupId: string, bounds: GroupFrameBounds) => {
    const current = history.scene.groups.find((group) => group.id === groupId);
    if (!current || current.sizeLocked || current.collapsed
      || (current.x === bounds.x && current.y === bounds.y
        && current.width === bounds.width && current.height === bounds.height)) return;
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (!group || group.sizeLocked || group.collapsed) return;
      Object.assign(group, bounds, { autoFit: false });
      reconcileAllMemberships(scene);
    });
  }, [history]);

  const deleteGroupById = useCallback((groupId: string, withContents: boolean) => {
    history.commit((scene) => {
      const remove = (id: string) => {
        const group = scene.groups.find((value) => value.id === id);
        if (!group) return;
        if (withContents) {
          const imageIds = new Set(group.members.filter((member) => member.type === 'image').map((member) => member.id));
          const markIds = new Set(group.members.filter((member) => member.type === 'mark').map((member) => member.id));
          group.members.filter((member) => member.type === 'group').forEach((member) => remove(member.id));
          deleteSceneSelection(scene, [...imageIds]);
          scene.visualNotes.marks = scene.visualNotes.marks.filter((mark) => !markIds.has(mark.id));
          scene.groups.forEach((value) => {
            value.members = value.members.filter((member) => member.type !== 'mark' || !markIds.has(member.id));
          });
        } else {
          group.members.filter((member) => member.type === 'group').forEach((member) => {
            const child = scene.groups.find((value) => value.id === member.id);
            if (child) child.parentId = undefined;
          });
        }
        scene.groups.forEach((value) => {
          value.members = value.members.filter((member) => member.type !== 'group' || member.id !== id);
        });
        scene.groups = scene.groups.filter((value) => value.id !== id);
      };
      remove(groupId);
      fitAutoGroupsToContents(scene);
    });
    setSelectedGroupId(undefined);
    setGroupColorEditor((current) => current?.id === groupId ? undefined : current);
    setRenamingGroupId((current) => current === groupId ? undefined : current);
    setStatus(withContents ? '已删除分组框及其内容' : '已删除分组框，内部对象已保留');
  }, [history, setStatus]);

  const deleteGroup = useCallback((withContents: boolean) => {
    if (selectedGroup) deleteGroupById(selectedGroup.id, withContents);
  }, [deleteGroupById, selectedGroup]);

  const toggleGroupAutoFit = useCallback((groupId: string) => {
    history.commit((scene) => {
      const group = scene.groups.find((value) => value.id === groupId);
      if (!group) return;
      group.autoFit = !(group.autoFit ?? true);
      if (group.autoFit) fitGroupToContents(scene, group.id);
    });
  }, [history]);

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
  }, [history, lastPointerRef, setStatus]);

  const showPrimarySource = useCallback(async () => {
    if (!primary?.sourcePath) { setStatus('这张图片来自剪贴板，或没有可用的本地源文件'); return; }
    const result = await api?.showSourceInFolder(primary.sourcePath);
    setStatus(result?.ok ? '已在资源管理器中定位源文件' : result?.message ?? '无法打开源文件位置');
  }, [api, primary, setStatus]);

  const moveLayer = useCallback((toFront: boolean) => {
    if (!selectedIds.length) return;
    history.commit((scene) => { scene.items = reorderImages(scene.items, selectedIds, toFront); });
  }, [history, selectedIds]);

  const layout = useCallback((action: LayoutAction) => {
    if (!targetIds.length) return;
    history.commit((scene) => {
      layoutSceneImages(scene, targetIds, action, window.innerWidth / Math.max(1, window.innerHeight));
    });
  }, [history, targetIds]);

  const commitItemChanges = useCallback((changes: Array<Partial<ImageItem> & { id: string }>, snap = true) => {
    history.commit((scene) => applyImageChanges(scene, changes, snap));
  }, [history]);

  const fitBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }, margin = 80) => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
      Math.min(width / (bounds.width + margin), height / (bounds.height + margin))));
    history.updateViewport({
      x: (width - bounds.width * scale) / 2 - bounds.x * scale,
      y: (height - bounds.height * scale) / 2 - bounds.y * scale,
      scale,
    });
  }, [history]);

  const fitItems = useCallback((items: ImageItem[]) => {
    if (items.length) fitBounds(sceneBounds(items));
  }, [fitBounds]);

  const fitCanvas = useCallback(() => {
    const bounds = [
      ...(history.scene.items.length ? [sceneBounds(history.scene.items)] : []),
      ...history.scene.groups.map(groupVisibleBounds),
    ];
    if (!bounds.length) return;
    const x = Math.min(...bounds.map((part) => part.x));
    const y = Math.min(...bounds.map((part) => part.y));
    const right = Math.max(...bounds.map((part) => part.x + part.width));
    const bottom = Math.max(...bounds.map((part) => part.y + part.height));
    fitBounds({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) });
  }, [fitBounds, history.scene.groups, history.scene.items]);

  const toggleFocus = useCallback((items: ImageItem[]) => {
    if (!items.length) return;
    if (focusReturn) {
      history.updateViewport(focusReturn);
      setFocusReturn(undefined);
      return;
    }
    setFocusReturn({ ...history.scene.viewport });
    fitItems(items);
  }, [fitItems, focusReturn, history]);

  const focusItem = useCallback((item: ImageItem) => {
    if (!focusReturn) setFocusReturn({ ...history.scene.viewport });
    fitBounds(sceneBounds([item]), 8);
  }, [fitBounds, focusReturn, history.scene.viewport]);

  const focusStep = useCallback((direction: -1 | 1) => {
    if (windowLocked) return;
    const ordered = [...history.scene.items].sort((a, b) => a.zIndex - b.zIndex);
    if (!ordered.length) return;
    const currentIndex = Math.max(0, ordered.findIndex((item) => item.id === primary?.id));
    const next = ordered[(currentIndex + direction + ordered.length) % ordered.length];
    if (!focusReturn) setFocusReturn({ ...history.scene.viewport });
    setSelectedIds([next.id]);
    fitItems([next]);
  }, [fitItems, focusReturn, history.scene.items, history.scene.viewport, primary?.id, windowLocked]);

  const resetZoom = useCallback(() => {
    const viewport = history.scene.viewport;
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const worldX = (centerX - viewport.x) / viewport.scale;
    const worldY = (centerY - viewport.y) / viewport.scale;
    history.updateViewport({ x: centerX - worldX, y: centerY - worldY, scale: 1 });
  }, [history]);

  const zoomBy = useCallback((factor: number) => {
    const viewport = history.scene.viewport;
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewport.scale * factor));
    const worldX = (centerX - viewport.x) / viewport.scale;
    const worldY = (centerY - viewport.y) / viewport.scale;
    history.updateViewport({ x: centerX - worldX * scale, y: centerY - worldY * scale, scale });
  }, [history]);

  const packAndFit = useCallback(() => {
    if (!targetIds.length) return;
    const targets = targetIds.flatMap((id) => {
      const item = history.scene.items.find((value) => value.id === id);
      return item ? [item] : [];
    });
    const transformed = applyLayout(targets, 'pack', history.scene.canvas.padding,
      window.innerWidth / Math.max(1, window.innerHeight));
    const byId = new Map(transformed.map((item) => [item.id, item]));
    const combined = history.scene.items.map((item) => byId.get(item.id) ?? item);
    history.commit((scene) => {
      scene.items = combined;
      transformed.forEach((item) => reconcileMemberBounds(scene, { type: 'image', id: item.id }, itemBounds(item)));
    });
    fitItems(transformed);
  }, [fitItems, history, targetIds]);

  const focusOutlineBounds = useCallback((bounds: { x: number; y: number; width: number; height: number }) => {
    if (!focusReturn) setFocusReturn({ ...history.scene.viewport });
    fitBounds(bounds, 72);
  }, [fitBounds, focusReturn, history.scene.viewport]);

  const selectOutlineImage = useCallback((item: ImageItem) => {
    if (windowLocked) return;
    setSelectedGroupId(undefined);
    setSelectedIds([item.id]);
  }, [windowLocked]);

  const focusOutlineImage = useCallback((item: ImageItem) => {
    if (windowLocked) return;
    selectOutlineImage(item);
    focusOutlineBounds(sceneBounds([item]));
  }, [focusOutlineBounds, selectOutlineImage, windowLocked]);

  const selectOutlineGroup = useCallback((group: ImageGroup) => {
    if (windowLocked) return;
    setSelectedIds([]);
    setSelectedGroupId(group.id);
  }, [windowLocked]);

  const focusOutlineGroup = useCallback((group: ImageGroup) => {
    if (windowLocked) return;
    selectOutlineGroup(group);
    focusOutlineBounds(groupVisibleBounds(group));
  }, [focusOutlineBounds, selectOutlineGroup, windowLocked]);

  const moveOutlineImageLayer = useCallback((id: string, direction: -1 | 1) => {
    const currentOrder = [...history.scene.items].sort((a, b) => a.zIndex - b.zIndex);
    const currentIndex = currentOrder.findIndex((item) => item.id === id);
    if (currentIndex < 0 || currentIndex + direction < 0 || currentIndex + direction >= currentOrder.length) return;
    history.commit((scene) => { moveImageLayer(scene, id, direction); });
  }, [history]);

  const toggleOutlineImageVisibility = useCallback((id: string) => history.commit((scene) => {
    const item = scene.items.find((value) => value.id === id);
    if (item) item.hidden = !item.hidden;
  }), [history]);

  const toggleOutlineImageLock = useCallback((id: string) => history.commit((scene) => {
    const item = scene.items.find((value) => value.id === id);
    if (item) item.locked = !item.locked;
  }), [history]);

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
    createGroup,
    renameGroupById,
    renameGroup,
    renamingGroupId,
    renameDraft,
    setRenameDraft,
    cancelGroupRename,
    finishGroupRename,
    ungroupSelected,
    detachImages,
    detachSelectedImages,
    addImagesToGroup,
    changeGroup,
    groupActionMenu,
    setGroupActionMenu,
    openGroupActions,
    groupColorEditor,
    setGroupColorEditor,
    groupColorEditorRef,
    moveGroupColorEditor,
    moveGroup,
    resizeGroup,
    deleteGroupById,
    deleteGroup,
    toggleGroupAutoFit,
    copySelection,
    cutSelection,
    pasteClipboard,
    hasClipboard: Boolean(sceneClipboardRef.current),
    showPrimarySource,
    moveLayer,
    layout,
    commitItemChanges,
    fitBounds,
    fitCanvas,
    toggleFocus,
    focusItem,
    focusStep,
    resetZoom,
    zoomBy,
    packAndFit,
    selectOutlineImage,
    focusOutlineImage,
    selectOutlineGroup,
    focusOutlineGroup,
    moveOutlineImageLayer,
    toggleOutlineImageVisibility,
    toggleOutlineImageLock,
  };
}
