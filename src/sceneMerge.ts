import { sceneBounds } from './scene';
import type { AssetRecord, Scene } from './types';
import { moveSceneMark } from './visualNotes/VisualNoteGeometry';

export interface SceneMergeResult {
  imageIds: string[];
  groupIds: string[];
  rootGroupIds: string[];
}

function combinedBounds(source: Scene) {
  const childGroupIds = new Set(source.groups.flatMap((group) => group.members
    .filter((member) => member.type === 'group').map((member) => member.id)));
  const groupedImageIds = new Set(source.groups.flatMap((group) => group.members
    .filter((member) => member.type === 'image').map((member) => member.id)));
  const parts = [
    ...(source.items.some((item) => !groupedImageIds.has(item.id))
      ? [sceneBounds(source.items.filter((item) => !groupedImageIds.has(item.id)))] : []),
    ...source.groups.filter((group) => !childGroupIds.has(group.id)).map((group) => ({ x: group.x, y: group.y, width: group.width, height: group.height })),
  ];
  return parts.reduce<{ x: number; y: number; width: number; height: number } | undefined>((current, value) => {
    if (!current) return value;
    const right = Math.max(current.x + current.width, value.x + value.width);
    const bottom = Math.max(current.y + current.height, value.y + value.height);
    const x = Math.min(current.x, value.x); const y = Math.min(current.y, value.y);
    return { x, y, width: right - x, height: bottom - y };
  }, undefined);
}

function assertCompatibleAssets(target: Scene, sourceAssets: Record<string, AssetRecord>) {
  Object.entries(sourceAssets).forEach(([id, source]) => {
    const targetAsset = target.assets[id];
    if (!targetAsset) return;
    if (targetAsset.hash !== source.hash || targetAsset.byteLength !== source.byteLength
      || targetAsset.mimeType !== source.mimeType || targetAsset.naturalWidth !== source.naturalWidth
      || targetAsset.naturalHeight !== source.naturalHeight) throw new Error(`资产冲突：${id}`);
  });
}

export function mergeSceneInto(target: Scene, source: Scene, placement: { x: number; y: number }): SceneMergeResult {
  assertCompatibleAssets(target, source.assets);
  const bounds = combinedBounds(source);
  const deltaX = placement.x - ((bounds?.x ?? 0) + (bounds?.width ?? 0) / 2);
  const deltaY = placement.y - ((bounds?.y ?? 0) + (bounds?.height ?? 0) / 2);
  const imageIds = new Map(source.items.map((item) => [item.id, crypto.randomUUID()]));
  const groupIds = new Map(source.groups.map((group) => [group.id, crypto.randomUUID()]));
  const markIds = new Map(source.visualNotes.marks.map((mark) => [mark.id, crypto.randomUUID()]));
  const maxZIndex = target.items.reduce((max, item) => Math.max(max, item.zIndex), -1);
  Object.assign(target.assets, structuredClone(source.assets));
  const items = source.items.map((item, index) => ({ ...structuredClone(item), id: imageIds.get(item.id)!, groupId: undefined,
    x: item.x + deltaX, y: item.y + deltaY, zIndex: maxZIndex + index + 1 }));
  const groups = source.groups.map((group) => ({
    ...structuredClone(group), id: groupIds.get(group.id)!, x: group.x + deltaX, y: group.y + deltaY,
    parentId: group.parentId ? groupIds.get(group.parentId) : undefined,
    detachedImageIds: group.detachedImageIds?.flatMap((id) => imageIds.get(id) ?? []),
    members: group.members.flatMap((member) => {
      const id = member.type === 'image' ? imageIds.get(member.id)
        : member.type === 'group' ? groupIds.get(member.id)
          : member.type === 'mark' ? markIds.get(member.id) : undefined;
      return id ? [{ ...member, id }] : [];
    }),
  }));
  const marks = source.visualNotes.marks.map((rawMark) => {
    const mark = structuredClone(rawMark);
    mark.id = markIds.get(rawMark.id)!;
    if (mark.anchor.type === 'image') mark.anchor.imageId = imageIds.get(mark.anchor.imageId)!;
    else return moveSceneMark(mark, deltaX, deltaY);
    return mark;
  });
  target.items.push(...items); target.groups.push(...groups);
  target.visualNotes.marks.push(...marks);
  target.visualNotes.nextNumber = Math.max(target.visualNotes.nextNumber,
    ...marks.flatMap((mark) => mark.kind === 'number' ? [mark.number + 1] : []));
  return { imageIds: items.map((item) => item.id), groupIds: groups.map((group) => group.id),
    rootGroupIds: groups.filter((group) => !group.parentId).map((group) => group.id) };
}
