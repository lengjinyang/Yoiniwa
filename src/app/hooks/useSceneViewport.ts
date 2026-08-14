import { useCallback, useState } from 'react';
import { applyLayout, type LayoutAction } from '../../domain/layout';
import { MAX_ZOOM, MIN_ZOOM } from '../../interactions';
import {
  groupVisibleBounds,
  itemBounds,
  reconcileMemberBounds,
  reorderImages,
  sceneBounds,
} from '../../domain/scene';
import { applyImageChanges, layoutSceneImages, moveImageLayer } from '../../domain/sceneCommands';
import type { ImageGroup, SceneItem, SceneItemPatch } from '../../types';
import type { SceneHistoryController } from '../../useSceneHistory';

export function useSceneViewport({
  history,
  windowLocked,
  selectedIds,
  targetIds,
  primary,
  setSelectedIds,
  setSelectedGroupId,
}: {
  history: SceneHistoryController;
  windowLocked: boolean;
  selectedIds: string[];
  targetIds: string[];
  primary?: SceneItem;
  setSelectedIds(ids: string[]): void;
  setSelectedGroupId(id?: string): void;
}) {
  const [focusReturn, setFocusReturn] = useState<typeof history.scene.viewport>();

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

  const commitItemChanges = useCallback((changes: Array<SceneItemPatch>, snap = true) => {
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

  const fitItems = useCallback((items: SceneItem[]) => {
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

  const toggleFocus = useCallback((items: SceneItem[]) => {
    if (!items.length) return;
    if (focusReturn) {
      history.updateViewport(focusReturn);
      setFocusReturn(undefined);
      return;
    }
    setFocusReturn({ ...history.scene.viewport });
    fitItems(items);
  }, [fitItems, focusReturn, history]);

  const focusItem = useCallback((item: SceneItem) => {
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
  }, [fitItems, focusReturn, history.scene.items, history.scene.viewport, primary?.id, setSelectedIds, windowLocked]);

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

  const selectOutlineImage = useCallback((item: SceneItem) => {
    if (windowLocked) return;
    setSelectedGroupId(undefined);
    setSelectedIds([item.id]);
  }, [setSelectedGroupId, setSelectedIds, windowLocked]);

  const focusOutlineImage = useCallback((item: SceneItem) => {
    if (windowLocked) return;
    selectOutlineImage(item);
    focusOutlineBounds(sceneBounds([item]));
  }, [focusOutlineBounds, selectOutlineImage, windowLocked]);

  const selectOutlineGroup = useCallback((group: ImageGroup) => {
    if (windowLocked) return;
    setSelectedIds([]);
    setSelectedGroupId(group.id);
  }, [setSelectedGroupId, setSelectedIds, windowLocked]);

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
