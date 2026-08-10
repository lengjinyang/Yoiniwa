import { useCallback } from 'react';
import type { LassoPoint } from '../../canvas/selection/SelectionController';
import { renderItems } from '../../exportScene';
import type { ImageItem, Scene } from '../../types';
import type { useVisualNotes } from './useVisualNotes';

interface UseSceneDeliveryOptions {
  api: Window['refCanvas'];
  scene: Scene;
  selectedItems: ImageItem[];
  lassoPoints?: LassoPoint[];
  photoshopDocumentBlocked: boolean;
  getVisualNotesForRender: ReturnType<typeof useVisualNotes>['getRenderNotes'];
  clearLasso(): void;
  beginOperation(kind: 'export' | 'photoshop', message: string): number;
  settleOperation(requestId: number, status: 'success' | 'error', message: string): void;
  clearOperation(requestId: number): void;
  setStatus(message: string): void;
}

export function useSceneDelivery({
  api,
  scene,
  selectedItems,
  lassoPoints,
  photoshopDocumentBlocked,
  getVisualNotesForRender,
  clearLasso,
  beginOperation,
  settleOperation,
  clearOperation,
  setStatus,
}: UseSceneDeliveryOptions) {
  const exportItems = useCallback(async (
    onlySelected: boolean,
    copy = false,
    format: 'png' | 'jpg' = 'png',
  ) => {
    if (!api) return;
    const items = onlySelected ? selectedItems : scene.items;
    if (!items.length) { setStatus('没有可导出的内容'); return; }
    const requestId = beginOperation('export', '正在渲染导出图片…');
    try {
      const selectedImageIds = new Set(items.map((item) => item.id));
      const notes = getVisualNotesForRender(onlySelected ? selectedImageIds : undefined);
      const imageData = await renderItems(
        items,
        scene.canvas.includeBackgroundOnExport ? scene.canvas.background : undefined,
        onlySelected ? [] : scene.groups,
        scene.canvas.backgroundOpacity ?? 1,
        notes,
      );
      if (copy) {
        await api.copyImage(imageData);
        settleOperation(requestId, 'success', '已将合成结果复制到剪贴板');
      } else {
        const originalBaseName = onlySelected && items.length === 1
          ? items[0].name.replace(/\.[^.]+$/, '') || items[0].name
          : undefined;
        const suggestedName = originalBaseName
          ? `${originalBaseName}.${format}`
          : `${scene.name}${onlySelected ? '-选中' : ''}.${format}`;
        const result = await api.exportImage(imageData, suggestedName);
        if (result.canceled) clearOperation(requestId);
        else settleOperation(requestId, 'success', `已导出至 ${result.path}`);
      }
    } catch (error) {
      settleOperation(requestId, 'error', `导出失败：${String(error)}`);
    }
  }, [api, beginOperation, clearOperation, getVisualNotesForRender, scene, selectedItems, setStatus, settleOperation]);

  const exportOriginalItems = useCallback(async () => {
    if (!api) return;
    if (!selectedItems.length) { setStatus('请先选择要导出的图片'); return; }
    if (selectedItems.some((item) => !item.assetId)) { setStatus('选中内容包含没有原图资源的图片'); return; }
    const requestId = beginOperation('export', '正在导出原图…');
    try {
      const result = await api.exportOriginalImages(selectedItems.map((item) => ({
        assetId: item.assetId!, suggestedName: item.name,
      })));
      if (result.canceled) clearOperation(requestId);
      else settleOperation(requestId, 'success', selectedItems.length === 1
        ? `已导出原图至 ${result.path}`
        : `已导出 ${result.count ?? selectedItems.length} 张原图至 ${result.path}`);
    } catch (error) {
      settleOperation(requestId, 'error', `导出原图失败：${String(error)}`);
    }
  }, [api, beginOperation, clearOperation, selectedItems, setStatus, settleOperation]);

  const copyPrimaryOriginal = useCallback(async () => {
    if (!api) return;
    if (selectedItems.length !== 1 || !selectedItems[0].assetId) {
      setStatus('请选择一张有原图资源的图片');
      return;
    }
    const requestId = beginOperation('export', '正在复制原图…');
    try {
      await api.copyOriginalImage(selectedItems[0].assetId);
      settleOperation(requestId, 'success', '已将原图复制到剪贴板');
    } catch (error) {
      settleOperation(requestId, 'error', `复制原图失败：${String(error)}`);
    }
  }, [api, beginOperation, selectedItems, settleOperation, setStatus]);

  const renderSelectedPhotoshopImage = useCallback(async () => {
    if (!selectedItems.length) throw new Error('请先选择要发送到 Photoshop 的图片');
    const selectedImageIds = new Set(selectedItems.map((item) => item.id));
    const pixelScale = Math.max(1, ...selectedItems.map((item) => Math.max(
      item.crop.width / Math.max(1, item.width),
      item.crop.height / Math.max(1, item.height),
    )));
    const notes = getVisualNotesForRender(selectedImageIds);
    return renderItems(selectedItems, undefined, [], 1, notes, { margin: 0, maxSide: 30000, pixelScale });
  }, [getVisualNotesForRender, selectedItems]);

  const renderSelectedPhotoshopLayers = useCallback(async () => {
    if (!selectedItems.length) throw new Error('请先选择要发送到 Photoshop 的图片');
    const layerItems = [...selectedItems].sort((left, right) => left.zIndex - right.zIndex);
    return Promise.all(layerItems.map(async (item) => {
      const notes = getVisualNotesForRender(new Set([item.id]));
      const pixelScale = Math.max(1,
        item.crop.width / Math.max(1, item.width), item.crop.height / Math.max(1, item.height));
      return {
        data: await renderItems([item], undefined, [], 1, notes, { margin: 0, maxSide: 30000, pixelScale }),
        name: item.name.replace(/\.[^.]+$/, '') || item.name,
      };
    }));
  }, [getVisualNotesForRender, selectedItems]);

  const renderLassoPhotoshopImage = useCallback(async () => {
    if (!selectedItems.length || !lassoPoints || lassoPoints.length < 3) {
      throw new Error('请先按住 D 绘制要发送的区域');
    }
    const selectedImageIds = new Set(selectedItems.map((item) => item.id));
    const pixelScale = Math.max(1, ...selectedItems.map((item) => Math.max(
      item.crop.width / Math.max(1, item.width),
      item.crop.height / Math.max(1, item.height),
    )));
    const notes = getVisualNotesForRender(selectedImageIds);
    return renderItems(selectedItems, undefined, [], 1, notes, {
      margin: 0,
      maxSide: 30000,
      pixelScale,
      clipPolygon: lassoPoints,
    });
  }, [getVisualNotesForRender, lassoPoints, selectedItems]);

  const sendSelectedToPhotoshop = useCallback(async (mode: 'layer' | 'image') => {
    if (!api || photoshopDocumentBlocked) return;
    clearLasso();
    const requestId = beginOperation(
      'photoshop',
      mode === 'layer' ? '正在发送图层到 Photoshop…' : '正在打开 Photoshop 图像…',
    );
    try {
      const hasLasso = Boolean(lassoPoints && lassoPoints.length >= 3);
      const result = mode === 'layer'
        ? await api.placeRenderedLayersInPhotoshop(hasLasso
          ? [{ data: await renderLassoPhotoshopImage(), name: `${scene.name}-选区` }]
          : await renderSelectedPhotoshopLayers())
        : await api.openRenderedInPhotoshop(
          hasLasso ? await renderLassoPhotoshopImage() : await renderSelectedPhotoshopImage(),
          selectedItems.length === 1
            ? selectedItems[0].name.replace(/\.[^.]+$/, '') || selectedItems[0].name
            : `${scene.name}-选中`,
        );
      if (result.ok) settleOperation(requestId, 'success', result.message ?? 'Photoshop 操作完成');
      else settleOperation(requestId, 'error', result.message ?? 'Photoshop 操作失败');
    } catch (error) {
      settleOperation(requestId, 'error', `发送到 Photoshop 失败：${String(error)}`);
    }
  }, [api, beginOperation, clearLasso, lassoPoints, photoshopDocumentBlocked, renderLassoPhotoshopImage,
    renderSelectedPhotoshopImage, renderSelectedPhotoshopLayers, scene.name, selectedItems, settleOperation]);

  return { exportItems, exportOriginalItems, copyPrimaryOriginal, sendSelectedToPhotoshop };
}
