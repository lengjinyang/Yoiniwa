import type { AnnotationItem, CropRect, GroupMember, ImageGroup, ImageItem, Scene } from './types';
import { normalizeTags } from './tags';

export const createScene = (): Scene => ({
  format: 'refcanvas',
  version: 2,
  name: '未命名画板',
  savedAt: new Date().toISOString(),
  viewport: { x: 0, y: 0, scale: 1 },
  canvas: { background: '#202124', padding: 20, snap: true, includeBackgroundOnExport: true },
  assets: {},
  items: [],
  groups: [],
  annotations: [],
});

/** Clone mutable scene metadata while sharing immutable asset records and image source strings. */
export const cloneScene = (scene: Scene): Scene => ({
  ...scene,
  viewport: { ...scene.viewport },
  canvas: { ...scene.canvas },
  assets: { ...scene.assets },
  items: scene.items.map((item) => ({ ...item, crop: { ...item.crop }, tags: item.tags ? [...item.tags] : undefined })),
  groups: scene.groups.map((group) => ({ ...group, tags: group.tags ? [...group.tags] : undefined, members: group.members.map((member) => ({ ...member })) })),
  annotations: scene.annotations.map((annotation) => ({ ...annotation, tags: annotation.tags ? [...annotation.tags] : undefined, points: annotation.points ? [...annotation.points] : undefined })),
});

export const normalizeZIndexes = (items: ImageItem[]) =>
  [...items].sort((a, b) => a.zIndex - b.zIndex).map((item, zIndex) => ({ ...item, zIndex }));

export function reorderImages(items: ImageItem[], selectedIds: string[], toFront: boolean) {
  const selectedSet = new Set(selectedIds);
  const ordered = [...items].sort((a, b) => a.zIndex - b.zIndex);
  const selected = ordered.filter((item) => selectedSet.has(item.id));
  const remaining = ordered.filter((item) => !selectedSet.has(item.id));
  return (toFront ? [...remaining, ...selected] : [...selected, ...remaining])
    .map((item, zIndex) => ({ ...item, zIndex }));
}

export const itemBounds = (item: ImageItem) => {
  const radians = item.rotation * Math.PI / 180;
  const width = Math.abs(item.width * Math.cos(radians)) + Math.abs(item.height * Math.sin(radians));
  const height = Math.abs(item.width * Math.sin(radians)) + Math.abs(item.height * Math.cos(radians));
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
};

export const sceneBounds = (items: ImageItem[]) => {
  if (!items.length) return { x: 0, y: 0, width: 1, height: 1 };
  const bounds = items.map(itemBounds);
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
};

export function translateItems(items: ImageItem[], deltaX: number, deltaY: number) {
  return items.map((item) => ({ id: item.id, x: item.x + deltaX, y: item.y + deltaY }));
}

export function scaleItemsAsGroup(items: ImageItem[], factor: number) {
  if (!items.length) return [];
  const bounds = sceneBounds(items);
  const groupCenterX = bounds.x + bounds.width / 2;
  const groupCenterY = bounds.y + bounds.height / 2;
  return items.map((item) => {
    const width = item.width * factor;
    const height = item.height * factor;
    const centerX = groupCenterX + (item.x + item.width / 2 - groupCenterX) * factor;
    const centerY = groupCenterY + (item.y + item.height / 2 - groupCenterY) * factor;
    return { id: item.id, x: centerX - width / 2, y: centerY - height / 2, width, height };
  });
}

export function rotateItemsAsGroup(items: ImageItem[], deltaDegrees: number) {
  if (!items.length) return [];
  const bounds = sceneBounds(items);
  const groupCenterX = bounds.x + bounds.width / 2;
  const groupCenterY = bounds.y + bounds.height / 2;
  const radians = deltaDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return items.map((item) => {
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;
    const offsetX = centerX - groupCenterX;
    const offsetY = centerY - groupCenterY;
    const rotatedCenterX = groupCenterX + offsetX * cosine - offsetY * sine;
    const rotatedCenterY = groupCenterY + offsetX * sine + offsetY * cosine;
    return {
      id: item.id,
      x: rotatedCenterX - item.width / 2,
      y: rotatedCenterY - item.height / 2,
      rotation: item.rotation + deltaDegrees,
    };
  });
}

export const GROUP_TITLE_HEIGHT = 28;
export const GROUP_PADDING = 18;
const GROUP_COLLAPSED_MIN_WIDTH = 88;

function estimatedGroupTitleWidth(name: string) {
  return Array.from(name).reduce((width, character) => width + (/^[\x00-\xff]$/.test(character) ? 6.5 : 11), 0);
}

/** A collapsed group keeps its stored frame size but presents as a compact title capsule. */
export function groupVisibleBounds(group: Pick<ImageGroup, 'name' | 'x' | 'y' | 'width' | 'height' | 'collapsed'>): Bounds {
  const width = group.collapsed
    ? Math.min(group.width, Math.max(GROUP_COLLAPSED_MIN_WIDTH, Math.ceil(estimatedGroupTitleWidth(group.name) + 58)))
    : group.width;
  return { x: group.x, y: group.y, width, height: group.collapsed ? GROUP_TITLE_HEIGHT : group.height };
}

export function topmostVisibleGroupAtPoint(
  groups: ImageGroup[],
  candidateIds: string[],
  hiddenGroupIds: ReadonlySet<string>,
  point: { x: number; y: number },
): string | undefined {
  const candidates = new Set(candidateIds);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!candidates.has(group.id) || hiddenGroupIds.has(group.id)) continue;
    const bounds = groupVisibleBounds(group);
    if (point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y && point.y <= bounds.y + bounds.height) return group.id;
  }
  return undefined;
}

export function annotationSceneBounds(annotation: AnnotationItem) {
  const padding = annotation.type === 'arrow' ? annotation.strokeWidth * 4 : annotation.strokeWidth / 2;
  if (annotation.points?.length) {
    const xs = annotation.points.filter((_, index) => index % 2 === 0);
    const ys = annotation.points.filter((_, index) => index % 2 === 1);
    const x = Math.min(...xs) - padding;
    const y = Math.min(...ys) - padding;
    return { x, y, width: Math.max(1, Math.max(...xs) + padding - x), height: Math.max(1, Math.max(...ys) + padding - y) };
  }
  return {
    x: (annotation.x ?? 0) - padding,
    y: (annotation.y ?? 0) - padding,
    width: Math.max(1, (annotation.width ?? 0) + padding * 2),
    height: Math.max(1, (annotation.height ?? 0) + padding * 2),
  };
}

export function moveAnnotation(annotation: AnnotationItem, deltaX: number, deltaY: number) {
  if (annotation.points) annotation.points = annotation.points.map((value, index) => value + (index % 2 === 0 ? deltaX : deltaY));
  else { annotation.x = (annotation.x ?? 0) + deltaX; annotation.y = (annotation.y ?? 0) + deltaY; }
}

function unionBounds(bounds: Array<{ x: number; y: number; width: number; height: number }>) {
  if (!bounds.length) return { x: 0, y: 0, width: 240, height: 160 };
  const x = Math.min(...bounds.map((value) => value.x));
  const y = Math.min(...bounds.map((value) => value.y));
  const right = Math.max(...bounds.map((value) => value.x + value.width));
  const bottom = Math.max(...bounds.map((value) => value.y + value.height));
  return { x, y, width: right - x, height: bottom - y };
}

export function createGroupFrame(scene: Scene, members: GroupMember[], name: string, id: string): ImageGroup {
  const bounds = unionBounds(members.flatMap((member) => {
    if (member.type === 'image') {
      const item = scene.items.find((value) => value.id === member.id);
      return item ? [itemBounds(item)] : [];
    }
    if (member.type === 'annotation') {
      const annotation = scene.annotations.find((value) => value.id === member.id);
      return annotation ? [annotationSceneBounds(annotation)] : [];
    }
    if (member.type === 'group') {
      const group = scene.groups.find((value) => value.id === member.id);
      return group ? [{ x: group.x, y: group.y, width: group.width, height: group.height }] : [];
    }
    return [];
  }));
  const group: ImageGroup = {
    id, name,
    x: bounds.x - GROUP_PADDING,
    y: bounds.y - GROUP_TITLE_HEIGHT - GROUP_PADDING,
    width: Math.max(140, bounds.width + GROUP_PADDING * 2),
    height: Math.max(80, bounds.height + GROUP_TITLE_HEIGHT + GROUP_PADDING * 2),
    color: '#536778', opacity: 0.2, titleColor: '#e7f6ff',
    collapsed: false, sizeLocked: false, contentsHidden: false, members: [],
  };
  for (const member of members) addMemberToGroup(scene, group, member);
  scene.groups.push(group);
  return group;
}

export function removeMemberFromGroups(scene: Scene, member: GroupMember) {
  scene.groups.forEach((group) => { group.members = group.members.filter((value) => !(value.type === member.type && value.id === member.id)); });
  if (member.type === 'group') {
    const child = scene.groups.find((group) => group.id === member.id);
    if (child) child.parentId = undefined;
  }
}

function canNestGroup(scene: Scene, childId: string, parentId: string) {
  if (childId === parentId) return false;
  let current = scene.groups.find((group) => group.id === parentId);
  const visited = new Set<string>();
  while (current) {
    if (current.id === childId || visited.has(current.id)) return false;
    visited.add(current.id);
    current = current.parentId ? scene.groups.find((group) => group.id === current!.parentId) : undefined;
  }
  return true;
}

export function addMemberToGroup(scene: Scene, group: ImageGroup, member: GroupMember) {
  if (member.type === 'group' && !canNestGroup(scene, member.id, group.id)) return false;
  removeMemberFromGroups(scene, member);
  if (!group.members.some((value) => value.type === member.type && value.id === member.id)) group.members.push(member);
  if (member.type === 'group') {
    const child = scene.groups.find((value) => value.id === member.id);
    if (child) child.parentId = group.id;
  }
  return true;
}

export interface Bounds { x: number; y: number; width: number; height: number }

function groupContentBounds(group: ImageGroup): Bounds {
  return { x: group.x, y: group.y + GROUP_TITLE_HEIGHT, width: group.width, height: Math.max(0, group.height - GROUP_TITLE_HEIGHT) };
}

function fullyContains(outer: Bounds, inner: Bounds) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function intersects(a: Bounds, b: Bounds) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function memberBounds(scene: Scene, member: GroupMember): Bounds | undefined {
  if (member.type === 'image') {
    const item = scene.items.find((value) => value.id === member.id);
    return item ? itemBounds(item) : undefined;
  }
  if (member.type === 'annotation') {
    const annotation = scene.annotations.find((value) => value.id === member.id);
    return annotation ? annotationSceneBounds(annotation) : undefined;
  }
  if (member.type === 'group') {
    const group = scene.groups.find((value) => value.id === member.id);
    return group ? groupVisibleBounds(group) : undefined;
  }
  return undefined;
}

export function reconcileMemberBounds(scene: Scene, member: GroupMember, bounds: Bounds) {
  const current = scene.groups.find((group) => group.members.some((value) => value.type === member.type && value.id === member.id));
  const candidates = scene.groups
    .filter((group) => !group.collapsed && fullyContains(groupContentBounds(group), bounds)
      && (member.type !== 'group' || canNestGroup(scene, member.id, group.id)))
    .sort((a, b) => a.width * a.height - b.width * b.height);
  const target = candidates[0];
  if (target) {
    if (target.id !== current?.id) addMemberToGroup(scene, target, member);
    return target.id;
  }
  if (current && intersects(groupContentBounds(current), bounds)) return current.id;
  if (current) removeMemberFromGroups(scene, member);
  return undefined;
}

export function reconcileAllMemberships(scene: Scene) {
  scene.items.forEach((item) => reconcileMemberBounds(scene, { type: 'image', id: item.id }, itemBounds(item)));
  scene.annotations.forEach((annotation) => reconcileMemberBounds(scene, { type: 'annotation', id: annotation.id }, annotationSceneBounds(annotation)));
  scene.groups.forEach((group) => {
    reconcileMemberBounds(scene, { type: 'group', id: group.id }, groupVisibleBounds(group));
  });
}

export function moveGroupWithContents(scene: Scene, groupId: string, deltaX: number, deltaY: number, visited = new Set<string>()) {
  if (visited.has(groupId)) return;
  visited.add(groupId);
  const group = scene.groups.find((value) => value.id === groupId);
  if (!group) return;
  group.x += deltaX; group.y += deltaY;
  for (const member of group.members) {
    if (member.type === 'image') {
      const item = scene.items.find((value) => value.id === member.id);
      if (item) { item.x += deltaX; item.y += deltaY; }
    } else if (member.type === 'annotation') {
      const annotation = scene.annotations.find((value) => value.id === member.id);
      if (annotation) moveAnnotation(annotation, deltaX, deltaY);
    } else if (member.type === 'group') moveGroupWithContents(scene, member.id, deltaX, deltaY, visited);
  }
}

export function normalizeScene(scene: Scene): Scene {
  const rawGroups = scene.groups ?? [];
  scene.groups = rawGroups.map((raw) => {
    const tags = normalizeTags(raw.tags);
    if (Array.isArray(raw.members) && Number.isFinite(raw.x)) return {
      ...raw,
      tags,
      sizeLocked: raw.sizeLocked ?? raw.locked ?? false,
      contentsHidden: raw.contentsHidden ?? raw.hidden ?? false,
      locked: undefined,
      hidden: undefined,
    };
    const legacyMembers: GroupMember[] = scene.items.filter((item) => item.groupId === raw.id).map((item) => ({ type: 'image', id: item.id }));
    const bounds = sceneBounds(scene.items.filter((item) => item.groupId === raw.id));
    return {
      ...raw, tags, x: bounds.x - GROUP_PADDING, y: bounds.y - GROUP_TITLE_HEIGHT - GROUP_PADDING,
      width: Math.max(140, bounds.width + GROUP_PADDING * 2), height: Math.max(80, bounds.height + GROUP_TITLE_HEIGHT + GROUP_PADDING * 2),
      color: '#536778', opacity: 0.2, titleColor: '#e7f6ff', collapsed: false, sizeLocked: false, contentsHidden: false, members: legacyMembers,
    };
  });
  scene.items.forEach((item) => {
    const tags = normalizeTags(item.tags);
    if (tags) item.tags = tags;
    else delete item.tags;
    item.groupId = undefined;
  });
  scene.annotations.forEach((annotation) => {
    const tags = normalizeTags(annotation.tags);
    if (tags) annotation.tags = tags;
    else delete annotation.tags;
  });
  return scene;
}

/** Compatibility wrapper for callers that only knew about group frame migration. */

export function applyNonDestructiveCrop(item: ImageItem, requestedCrop: CropRect) {
  const x = Math.max(0, Math.min(item.naturalWidth - 1, requestedCrop.x));
  const y = Math.max(0, Math.min(item.naturalHeight - 1, requestedCrop.y));
  const crop = {
    x,
    y,
    width: Math.max(1, Math.min(requestedCrop.width, item.naturalWidth - x)),
    height: Math.max(1, Math.min(requestedCrop.height, item.naturalHeight - y)),
  };
  const scaleX = item.width / Math.max(1, item.crop.width);
  const scaleY = item.height / Math.max(1, item.crop.height);
  const localX = (crop.x + crop.width / 2 - item.crop.x - item.crop.width / 2) * scaleX * (item.flipX ? -1 : 1);
  const localY = (crop.y + crop.height / 2 - item.crop.y - item.crop.height / 2) * scaleY * (item.flipY ? -1 : 1);
  const radians = item.rotation * Math.PI / 180;
  const centerX = item.x + item.width / 2 + localX * Math.cos(radians) - localY * Math.sin(radians);
  const centerY = item.y + item.height / 2 + localX * Math.sin(radians) + localY * Math.cos(radians);
  item.width = crop.width * scaleX;
  item.height = crop.height * scaleY;
  item.x = centerX - item.width / 2;
  item.y = centerY - item.height / 2;
  item.crop = crop;
}

export function resetNonDestructiveCrop(item: ImageItem) {
  applyNonDestructiveCrop(item, { x: 0, y: 0, width: item.naturalWidth, height: item.naturalHeight });
}

export function resetImageTransform(item: ImageItem) {
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.height / 2;
  const scale = Math.min(1, 480 / Math.max(item.naturalWidth, item.naturalHeight));
  item.crop = { x: 0, y: 0, width: item.naturalWidth, height: item.naturalHeight };
  item.width = item.naturalWidth * scale;
  item.height = item.naturalHeight * scale;
  item.x = centerX - item.width / 2;
  item.y = centerY - item.height / 2;
  item.rotation = 0;
  item.flipX = false;
  item.flipY = false;
  item.opacity = 1;
}

export function validateScene(value: unknown): value is Scene {
  if (!value || typeof value !== 'object') return false;
  const scene = value as Partial<Scene>;
  return scene.format === 'refcanvas' && scene.version === 2 && Array.isArray(scene.items)
    && !!scene.assets && typeof scene.assets === 'object' && !!scene.viewport && !!scene.canvas;
}
