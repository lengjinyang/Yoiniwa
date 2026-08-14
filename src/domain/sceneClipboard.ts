import { groupVisibleBounds, sceneBounds } from './scene';
import type { AssetRecord, ImageGroup, SceneItem, Scene, VisualNotesState } from '../types';
import { markWorldBounds, moveSceneMark } from './visualNoteGeometry';

export interface SceneClipboardPayload {
  items: SceneItem[];
  groups: ImageGroup[];
  assets: Record<string, AssetRecord>;
  visualNotes: VisualNotesState;
  rootGroupId?: string;
}

export function captureSceneSelection(scene: Scene, imageIds: string[], groupId?: string): SceneClipboardPayload | undefined {
  const images = new Set(imageIds);
  const groups = new Set<string>();
  const markIds = new Set<string>();
  const collect = (id: string) => {
    if (groups.has(id)) return;
    const group = scene.groups.find((value) => value.id === id);
    if (!group) return;
    groups.add(id);
    group.members.forEach((member) => {
      if (member.type === 'image') images.add(member.id);
      else if (member.type === 'group') collect(member.id);
      else if (member.type === 'mark') markIds.add(member.id);
    });
  };
  if (groupId) collect(groupId);
  if (!images.size && !groups.size) return;
  const items = scene.items.filter((item) => images.has(item.id));
  scene.visualNotes.marks.forEach((mark) => {
    if (mark.anchor.type === 'image' && images.has(mark.anchor.imageId)) markIds.add(mark.id);
  });
  const assetIds = new Set(items.flatMap((item) => item.assetId ? [item.assetId] : []));
  return structuredClone({
    items,
    groups: scene.groups.filter((group) => groups.has(group.id)),
    assets: Object.fromEntries(Object.entries(scene.assets).filter(([id]) => assetIds.has(id))),
    visualNotes: {
      visible: scene.visualNotes.visible,
      nextNumber: scene.visualNotes.nextNumber,
      marks: scene.visualNotes.marks.filter((mark) => markIds.has(mark.id)),
    },
    rootGroupId: groupId,
  });
}

export function pasteScenePayload(scene: Scene, payload: SceneClipboardPayload, placement: number | { x: number; y: number } = 30) {
  Object.assign(scene.assets, payload.assets ?? {});
  const bounds = [
    ...(payload.items.length ? [sceneBounds(payload.items)] : []),
    ...payload.groups.map(groupVisibleBounds),
    ...payload.visualNotes.marks.flatMap((mark) => markWorldBounds(mark, payload.items) ?? []),
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
  const groupIds = new Map(payload.groups.map((group) => [group.id, crypto.randomUUID()]));
  const markIds = new Map(payload.visualNotes.marks.map((mark) => [mark.id, crypto.randomUUID()]));
  const items = payload.items.map((item, index) => ({
    ...structuredClone(item), id: imageIds.get(item.id)!, groupId: undefined,
    x: item.x + deltaX, y: item.y + deltaY, zIndex: scene.items.length + index,
  }));
  const groups = payload.groups.map((group) => ({
    ...structuredClone(group), id: groupIds.get(group.id)!, x: group.x + deltaX, y: group.y + deltaY,
    parentId: group.parentId ? groupIds.get(group.parentId) : undefined,
    detachedImageIds: undefined,
    members: group.members.flatMap((member) => {
      const id = member.type === 'image' ? imageIds.get(member.id)
        : member.type === 'group' ? groupIds.get(member.id)
          : member.type === 'mark' ? markIds.get(member.id) : undefined;
      return id ? [{ ...member, id }] : [];
    }),
  }));
  const marks = payload.visualNotes.marks.map((rawMark) => {
    const mark = structuredClone(rawMark);
    mark.id = markIds.get(rawMark.id)!;
    if (mark.anchor.type === 'image') mark.anchor.imageId = imageIds.get(mark.anchor.imageId)!;
    else return moveSceneMark(mark, deltaX, deltaY);
    return mark;
  });
  scene.items.push(...items); scene.groups.push(...groups);
  scene.visualNotes.marks.push(...marks);
  scene.visualNotes.nextNumber = Math.max(scene.visualNotes.nextNumber,
    ...marks.flatMap((mark) => mark.kind === 'number' ? [mark.number + 1] : []));
  return {
    imageIds: items.map((item) => item.id),
    rootGroupId: payload.rootGroupId ? groupIds.get(payload.rootGroupId) : undefined,
  };
}
