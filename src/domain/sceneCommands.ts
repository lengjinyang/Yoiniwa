import { applyLayout, type LayoutAction } from '../layout';
import { fitAutoGroupsToContents, itemBounds, memberBounds, normalizeZIndexes, reconcileMemberBounds } from '../scene';
import type { ImageItem, Scene } from '../types';

export type ImageChange = Partial<ImageItem> & { id: string };

export function deleteSceneSelection(scene: Scene, imageIds: readonly string[]) {
  const images = new Set(imageIds);
  const removedMarkIds = new Set(scene.visualNotes.marks
    .filter((mark) => mark.anchor.type === 'image' && images.has(mark.anchor.imageId))
    .map((mark) => mark.id));
  scene.items = normalizeZIndexes(scene.items.filter((item) => !images.has(item.id)));
  scene.visualNotes.marks = scene.visualNotes.marks.filter((mark) => !removedMarkIds.has(mark.id));
  scene.groups.forEach((group) => {
    group.members = group.members.filter((member) => (member.type !== 'image' || !images.has(member.id))
      && (member.type !== 'mark' || !removedMarkIds.has(member.id)));
    if (group.detachedImageIds) {
      group.detachedImageIds = group.detachedImageIds.filter((id) => !images.has(id));
      if (!group.detachedImageIds.length) delete group.detachedImageIds;
    }
  });
  fitAutoGroupsToContents(scene);
}

export function applyImageChanges(scene: Scene, changes: readonly ImageChange[]) {
  changes.forEach((rawChange) => {
    const item = scene.items.find((value) => value.id === rawChange.id);
    if (!item) return;
    const change = { ...rawChange };
    if (scene.canvas.snap && changes.length === 1 && change.x !== undefined && change.y !== undefined) {
      const width = change.width ?? item.width;
      const height = change.height ?? item.height;
      const threshold = 10 / scene.viewport.scale;
      const others = scene.items.filter((value) => value.id !== item.id);
      const verticalLines = others.flatMap((value) => [value.x, value.x + value.width / 2, value.x + value.width]);
      const horizontalLines = others.flatMap((value) => [value.y, value.y + value.height / 2, value.y + value.height]);
      const movingX = [change.x, change.x + width / 2, change.x + width];
      const movingY = [change.y, change.y + height / 2, change.y + height];
      let bestX = threshold;
      let bestY = threshold;
      for (const from of movingX) for (const to of verticalLines) {
        const offset = to - from;
        if (Math.abs(offset) < Math.abs(bestX)) bestX = offset;
      }
      for (const from of movingY) for (const to of horizontalLines) {
        const offset = to - from;
        if (Math.abs(offset) < Math.abs(bestY)) bestY = offset;
      }
      if (Math.abs(bestX) < threshold) change.x += bestX;
      if (Math.abs(bestY) < threshold) change.y += bestY;
    }
    Object.assign(item, change);
  });
  changes.forEach((change) => {
    const item = scene.items.find((value) => value.id === change.id);
    if (!item || (change.x === undefined && change.y === undefined && change.width === undefined && change.height === undefined)) return;
    const bounds = memberBounds(scene, { type: 'image', id: item.id });
    if (bounds) reconcileMemberBounds(scene, { type: 'image', id: item.id }, bounds);
  });
}

export function layoutSceneImages(scene: Scene, targetIds: readonly string[], action: LayoutAction, targetAspect: number) {
  const selected = new Set(targetIds);
  const targets = scene.items.filter((item) => selected.has(item.id));
  const transformed = applyLayout(targets, action, scene.canvas.padding, targetAspect);
  const byId = new Map(transformed.map((item) => [item.id, item]));
  scene.items = scene.items.map((item) => byId.get(item.id) ?? item);
  transformed.forEach((item) => reconcileMemberBounds(scene, { type: 'image', id: item.id }, itemBounds(item)));
  return transformed;
}

export function moveImageLayer(scene: Scene, id: string, direction: -1 | 1) {
  const ordered = [...scene.items].sort((left, right) => left.zIndex - right.zIndex);
  const index = ordered.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ordered.length) return false;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  scene.items = ordered.map((item, zIndex) => ({ ...item, zIndex }));
  return true;
}
