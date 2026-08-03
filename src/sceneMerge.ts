import { annotationSceneBounds, moveAnnotation, sceneBounds } from './scene';
import type { AssetRecord, Scene } from './types';

export interface SceneMergeResult {
  imageIds: string[];
  annotationIds: string[];
  groupIds: string[];
  rootGroupIds: string[];
}

function combinedBounds(source: Scene) {
  const childGroupIds = new Set(source.groups.flatMap((group) => group.members
    .filter((member) => member.type === 'group').map((member) => member.id)));
  const groupedImageIds = new Set(source.groups.flatMap((group) => group.members
    .filter((member) => member.type === 'image').map((member) => member.id)));
  const groupedAnnotationIds = new Set(source.groups.flatMap((group) => group.members
    .filter((member) => member.type === 'annotation').map((member) => member.id)));
  const parts = [
    ...(source.items.filter((item) => !groupedImageIds.has(item.id)).length
      ? [sceneBounds(source.items.filter((item) => !groupedImageIds.has(item.id)))] : []),
    ...source.annotations.filter((annotation) => !groupedAnnotationIds.has(annotation.id)).map(annotationSceneBounds),
    ...source.groups.filter((group) => !childGroupIds.has(group.id)).map((group) => ({ x: group.x, y: group.y, width: group.width, height: group.height })),
  ];
  return parts.reduce<{ x: number; y: number; width: number; height: number } | undefined>((current, value) => {
    if (!current) return value;
    const right = Math.max(current.x + current.width, value.x + value.width);
    const bottom = Math.max(current.y + current.height, value.y + value.height);
    const x = Math.min(current.x, value.x);
    const y = Math.min(current.y, value.y);
    return { x, y, width: right - x, height: bottom - y };
  }, undefined);
}

function assertCompatibleAssets(target: Scene, sourceAssets: Record<string, AssetRecord>) {
  Object.entries(sourceAssets).forEach(([id, source]) => {
    const targetAsset = target.assets[id];
    if (!targetAsset) return;
    if (
      targetAsset.hash !== source.hash
      || targetAsset.byteLength !== source.byteLength
      || targetAsset.mimeType !== source.mimeType
      || targetAsset.naturalWidth !== source.naturalWidth
      || targetAsset.naturalHeight !== source.naturalHeight
    ) throw new Error(`资产冲突：${id}`);
  });
}

function usedSourceAssets(source: Scene) {
  return { ...source.assets };
}

export function mergeSceneInto(target: Scene, source: Scene, placement: { x: number; y: number }): SceneMergeResult {
  const sourceAssets = usedSourceAssets(source);
  assertCompatibleAssets(target, sourceAssets);
  const sourceBounds = combinedBounds(source);
  const deltaX = placement.x - ((sourceBounds?.x ?? 0) + (sourceBounds?.width ?? 0) / 2);
  const deltaY = placement.y - ((sourceBounds?.y ?? 0) + (sourceBounds?.height ?? 0) / 2);
  const imageIds = new Map(source.items.map((item) => [item.id, crypto.randomUUID()]));
  const annotationIds = new Map(source.annotations.map((annotation) => [annotation.id, crypto.randomUUID()]));
  const groupIds = new Map(source.groups.map((group) => [group.id, crypto.randomUUID()]));
  const maxZIndex = target.items.reduce((max, item) => Math.max(max, item.zIndex), -1);

  Object.assign(target.assets, structuredClone(sourceAssets));
  const items = source.items.map((item, index) => ({
    ...structuredClone(item),
    id: imageIds.get(item.id)!,
    groupId: undefined,
    x: item.x + deltaX,
    y: item.y + deltaY,
    zIndex: maxZIndex + index + 1,
  }));
  const annotations = source.annotations.map((annotation) => {
    const copy = { ...structuredClone(annotation), id: annotationIds.get(annotation.id)! };
    moveAnnotation(copy, deltaX, deltaY);
    return copy;
  });
  const groups = source.groups.map((group) => ({
    ...structuredClone(group),
    id: groupIds.get(group.id)!,
    x: group.x + deltaX,
    y: group.y + deltaY,
    parentId: group.parentId ? groupIds.get(group.parentId) : undefined,
    detachedImageIds: group.detachedImageIds?.flatMap((id) => {
      const mapped = imageIds.get(id);
      return mapped ? [mapped] : [];
    }),
    members: group.members.flatMap((member) => {
      const id = member.type === 'image' ? imageIds.get(member.id)
        : member.type === 'annotation' ? annotationIds.get(member.id)
          : groupIds.get(member.id);
      return id ? [{ ...member, id }] : [];
    }),
  }));
  target.items.push(...items);
  target.annotations.push(...annotations);
  target.groups.push(...groups);
  const rootGroupIds = groups.filter((group) => !group.parentId).map((group) => group.id);
  return {
    imageIds: items.map((item) => item.id),
    annotationIds: annotations.map((annotation) => annotation.id),
    groupIds: groups.map((group) => group.id),
    rootGroupIds,
  };
}
