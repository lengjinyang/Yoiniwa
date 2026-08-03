import { annotationSceneBounds, groupVisibleBounds, sceneBounds } from './scene';
import type { AnnotationItem, ImageGroup, ImageItem } from './types';
import { imageSource } from './imageResources';
import ExportSceneWorker from './workers/exportScene.worker?worker';

export function annotationBounds(annotation: AnnotationItem) {
  return annotationSceneBounds(annotation);
}

export function exportVisibility(groups: ImageGroup[]) {
  const hiddenImages = new Set<string>();
  const hiddenAnnotations = new Set<string>();
  const hiddenGroups = new Set<string>();
  const visit = (id: string, hideFrame: boolean, visited = new Set<string>()) => {
    if (visited.has(id)) return;
    visited.add(id);
    const group = groups.find((value) => value.id === id);
    if (!group) return;
    if (hideFrame) hiddenGroups.add(id);
    group.members.forEach((member) => {
      if (member.type === 'image') hiddenImages.add(member.id);
      else if (member.type === 'annotation') hiddenAnnotations.add(member.id);
      else if (member.type === 'group') visit(member.id, true, visited);
    });
  };
  groups.forEach((group) => { if (group.collapsed || group.contentsHidden) group.members.forEach((member) => {
    if (member.type === 'image') hiddenImages.add(member.id);
    else if (member.type === 'annotation') hiddenAnnotations.add(member.id);
    else if (member.type === 'group') visit(member.id, true);
  }); });
  return { hiddenImages, hiddenAnnotations, hiddenGroups };
}

function combinedBounds(items: ImageItem[], annotations: AnnotationItem[], groups: ImageGroup[]) {
  const parts = [
    ...(items.length ? [sceneBounds(items)] : []),
    ...annotations.map(annotationBounds),
    ...groups.map(groupVisibleBounds),
  ];
  if (!parts.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...parts.map((part) => part.x));
  const y = Math.min(...parts.map((part) => part.y));
  const right = Math.max(...parts.map((part) => part.x + part.width));
  const bottom = Math.max(...parts.map((part) => part.y + part.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export async function renderItems(
  items: ImageItem[], background?: string, annotations: AnnotationItem[] = [], groups: ImageGroup[] = [], backgroundOpacity = 1,
): Promise<ArrayBuffer> {
  const visibility = exportVisibility(groups);
  const visibleGroups = groups.filter((group) => !visibility.hiddenGroups.has(group.id));
  const visibleItems = items.filter((item) => !item.hidden && !visibility.hiddenImages.has(item.id));
  const visibleAnnotations = annotations.filter((annotation) => !annotation.hidden && !visibility.hiddenAnnotations.has(annotation.id));
  const bounds = combinedBounds(visibleItems, visibleAnnotations, visibleGroups);
  const margin = 24;
  const maxSide = 12000;
  const scale = Math.min(1, maxSide / Math.max(bounds.width + margin * 2, bounds.height + margin * 2));
  const ordered = [...visibleItems].sort((a, b) => a.zIndex - b.zIndex);
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
        items: ordered.map((item) => ({ ...item, resourceUrl: imageSource(item, 'original') })),
        annotations: visibleAnnotations, groups: visibleGroups,
      });
    });
  } finally { worker.terminate(); }
}
