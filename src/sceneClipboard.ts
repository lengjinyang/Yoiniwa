import { annotationSceneBounds, groupVisibleBounds, moveAnnotation, sceneBounds } from './scene';
import type { AnnotationItem, AssetRecord, ImageGroup, ImageItem, Scene } from './types';

export interface SceneClipboardPayload {
  items: ImageItem[];
  annotations: AnnotationItem[];
  groups: ImageGroup[];
  assets: Record<string, AssetRecord>;
  rootGroupId?: string;
}

export function captureSceneSelection(scene: Scene, imageIds: string[], annotationIds: string[], groupId?: string): SceneClipboardPayload | undefined {
  const images = new Set(imageIds); const annotations = new Set(annotationIds); const groups = new Set<string>();
  const collect = (id: string) => {
    if (groups.has(id)) return;
    const group = scene.groups.find((value) => value.id === id);
    if (!group) return;
    groups.add(id);
    group.members.forEach((member) => {
      if (member.type === 'image') images.add(member.id);
      else if (member.type === 'annotation') annotations.add(member.id);
      else if (member.type === 'group') collect(member.id);
    });
  };
  if (groupId) collect(groupId);
  if (!images.size && !annotations.size && !groups.size) return;
  const items = scene.items.filter((item) => images.has(item.id));
  const assetIds = new Set(items.flatMap((item) => item.assetId ? [item.assetId] : []));
  return structuredClone({
    items,
    annotations: scene.annotations.filter((item) => annotations.has(item.id)),
    groups: scene.groups.filter((group) => groups.has(group.id)),
    assets: Object.fromEntries(Object.entries(scene.assets).filter(([id]) => assetIds.has(id))),
    rootGroupId: groupId,
  });
}

export function pasteScenePayload(scene: Scene, payload: SceneClipboardPayload, placement: number | { x: number; y: number } = 30) {
  Object.assign(scene.assets, payload.assets ?? {});
  const bounds = [
    ...(payload.items.length ? [sceneBounds(payload.items)] : []),
    ...payload.annotations.map(annotationSceneBounds),
    ...payload.groups.map(groupVisibleBounds),
  ].reduce<{ x: number; y: number; width: number; height: number } | undefined>((combined, value) => {
    if (!combined) return value;
    const right = Math.max(combined.x + combined.width, value.x + value.width);
    const bottom = Math.max(combined.y + combined.height, value.y + value.height);
    const x = Math.min(combined.x, value.x); const y = Math.min(combined.y, value.y);
    return { x, y, width: right - x, height: bottom - y };
  }, undefined);
  const deltaX = typeof placement === 'number' ? placement : placement.x - ((bounds?.x ?? 0) + (bounds?.width ?? 0) / 2);
  const deltaY = typeof placement === 'number' ? placement : placement.y - ((bounds?.y ?? 0) + (bounds?.height ?? 0) / 2);
  const imageIds = new Map(payload.items.map((item) => [item.id, crypto.randomUUID()]));
  const annotationIds = new Map(payload.annotations.map((item) => [item.id, crypto.randomUUID()]));
  const groupIds = new Map(payload.groups.map((group) => [group.id, crypto.randomUUID()]));
  const items = payload.items.map((item, index) => ({
    ...structuredClone(item), id: imageIds.get(item.id)!, groupId: undefined,
    x: item.x + deltaX, y: item.y + deltaY, zIndex: scene.items.length + index,
  }));
  const annotations = payload.annotations.map((item) => {
    const copy = { ...structuredClone(item), id: annotationIds.get(item.id)! };
    moveAnnotation(copy, deltaX, deltaY);
    return copy;
  });
  const groups = payload.groups.map((group) => ({
    ...structuredClone(group), id: groupIds.get(group.id)!, x: group.x + deltaX, y: group.y + deltaY,
    parentId: group.parentId ? groupIds.get(group.parentId) : undefined,
    // Detached images are not descendants of a copied group, so their old IDs
    // must not leak into the pasted frame.
    detachedImageIds: undefined,
    members: group.members.flatMap((member) => {
      const id = member.type === 'image' ? imageIds.get(member.id)
        : member.type === 'annotation' ? annotationIds.get(member.id)
          : member.type === 'group' ? groupIds.get(member.id) : undefined;
      return id ? [{ ...member, id }] : [];
    }),
  }));
  scene.items.push(...items); scene.annotations.push(...annotations); scene.groups.push(...groups);
  return {
    imageIds: items.map((item) => item.id), annotationIds: annotations.map((item) => item.id),
    rootGroupId: payload.rootGroupId ? groupIds.get(payload.rootGroupId) : undefined,
  };
}
