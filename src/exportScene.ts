import { groupVisibleBounds, sceneBounds } from './domain/scene';
import { exportVisibility } from './domain/exportVisibility';
import type { ImageGroup, SceneItem, VisualNotesState } from './types';
import { imageSource } from './runtime/imageResources';
import ExportSceneWorker from './workers/exportScene.worker?worker';
import { markWorldBounds } from './visualNotes/VisualNoteGeometry';

export { exportVisibility };

function combinedBounds(items: SceneItem[], groups: ImageGroup[], visualNotes?: VisualNotesState) {
  const parts = [...(items.length ? [sceneBounds(items)] : []), ...groups.map(groupVisibleBounds),
    ...(visualNotes?.visible ? visualNotes.marks.flatMap((mark) => markWorldBounds(mark, items) ?? []) : [])];
  if (!parts.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...parts.map((part) => part.x));
  const y = Math.min(...parts.map((part) => part.y));
  const right = Math.max(...parts.map((part) => part.x + part.width));
  const bottom = Math.max(...parts.map((part) => part.y + part.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export async function renderItems(
  items: SceneItem[], background?: string, groups: ImageGroup[] = [], backgroundOpacity = 1,
  visualNotes?: VisualNotesState, options: {
    margin?: number; maxSide?: number; pixelScale?: number; clipPolygon?: Array<{ x: number; y: number }>;
  } = {},
): Promise<ArrayBuffer> {
  const visibility = exportVisibility(groups);
  const visibleGroups = groups.filter((group) => !visibility.hiddenGroups.has(group.id));
  const visibleItems = items.filter((item) => !item.hidden && !visibility.hiddenImages.has(item.id));
  const visibleImageIds = new Set(visibleItems.map((item) => item.id));
  const exportNotes = visualNotes && visualNotes.visible ? {
    ...structuredClone(visualNotes),
    marks: visualNotes.marks.filter((mark) => !visibility.hiddenMarks.has(mark.id)
      && (mark.anchor.type === 'scene' || visibleImageIds.has(mark.anchor.imageId))),
  } : visualNotes;
  const clipPolygon = options.clipPolygon?.length && options.clipPolygon.length >= 3 ? options.clipPolygon : undefined;
  const bounds = clipPolygon ? polygonBounds(clipPolygon) : combinedBounds(visibleItems, visibleGroups, exportNotes);
  const margin = Math.max(0, options.margin ?? 24);
  const maxSide = Math.max(1, options.maxSide ?? 12000);
  const requestedScale = Math.max(1, options.pixelScale ?? 1);
  const scale = requestedScale * Math.min(1,
    maxSide / (Math.max(bounds.width + margin * 2, bounds.height + margin * 2) * requestedScale));
  const worker = new ExportSceneWorker();
  try {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ ok: boolean; buffer?: ArrayBuffer; error?: string }>) => {
        if (event.data.ok && event.data.buffer) resolve(event.data.buffer);
        else reject(new Error(event.data.error ?? '后台导出失败'));
      };
      worker.onerror = (event) => reject(new Error(event.message || '后台导出 Worker 失败'));
      worker.postMessage({
        width: Math.max(1, Math.ceil((bounds.width + margin * 2) * scale)),
        height: Math.max(1, Math.ceil((bounds.height + margin * 2) * scale)),
        scale, offsetX: -bounds.x + margin, offsetY: -bounds.y + margin, background, backgroundOpacity,
        items: [...visibleItems].sort((a, b) => a.zIndex - b.zIndex)
          .map((item) => ({ ...item, resourceUrl: imageSource(item, 'original') })),
        groups: visibleGroups,
        visualNotes: exportNotes,
        clipPolygon,
      });
    });
  } finally { worker.terminate(); }
}

function polygonBounds(points: Array<{ x: number; y: number }>) {
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}
