import type { AnnotationItem, ImageGroup, ImageItem, Scene } from './types';

export type OutlineObject = ImageItem | ImageGroup | AnnotationItem;

export interface OutlineFilter {
  query?: string;
  tags?: readonly string[];
  tagMode?: 'any' | 'all';
  types?: ReadonlySet<'image' | 'group' | 'annotation'>;
  visibility?: 'all' | 'visible' | 'hidden';
  lock?: 'all' | 'locked' | 'unlocked';
  hasComment?: 'all' | 'yes' | 'no';
}

const annotationNames: Record<AnnotationItem['type'], string> = {
  pen: '自由线',
  arrow: '箭头',
  rectangle: '矩形',
  ellipse: '椭圆',
};

function includesQuery(value: string | undefined, query: string) {
  return !query || value?.toLocaleLowerCase().includes(query);
}

function matchesTags(tags: readonly string[] | undefined, requested: readonly string[], mode: 'any' | 'all') {
  if (!requested.length) return true;
  const available = new Set((tags ?? []).map((tag) => tag.toLocaleLowerCase()));
  return mode === 'all'
    ? requested.every((tag) => available.has(tag.toLocaleLowerCase()))
    : requested.some((tag) => available.has(tag.toLocaleLowerCase()));
}

export function annotationLabel(annotation: AnnotationItem) {
  return annotationNames[annotation.type];
}

export function outlineObjectMatches(
  object: OutlineObject,
  type: 'image' | 'group' | 'annotation',
  filter: OutlineFilter = {},
) {
  if (filter.types && !filter.types.has(type)) return false;
  const group = object as ImageGroup;
  const hidden = type === 'group' ? group.contentsHidden : Boolean((object as ImageItem | AnnotationItem).hidden);
  if (filter.visibility === 'visible' && hidden) return false;
  if (filter.visibility === 'hidden' && !hidden) return false;
  const locked = type === 'group' ? group.sizeLocked : Boolean((object as ImageItem | AnnotationItem).locked);
  if (filter.lock === 'locked' && !locked) return false;
  if (filter.lock === 'unlocked' && locked) return false;
  const image = object as ImageItem;
  if (type === 'image' && filter.hasComment === 'yes' && !image.comment) return false;
  if (type === 'image' && filter.hasComment === 'no' && image.comment) return false;

  const query = filter.query?.trim().toLocaleLowerCase() ?? '';
  const label = type === 'annotation'
    ? annotationLabel(object as AnnotationItem)
    : (object as ImageItem | ImageGroup).name;
  const comment = type === 'image' ? image.comment : undefined;
  if (!includesQuery(label, query) && !includesQuery(comment, query)
    && !(object.tags ?? []).some((tag) => tag.toLocaleLowerCase().includes(query))) return false;

  return matchesTags(object.tags, filter.tags ?? [], filter.tagMode ?? 'any');
}

export function groupOrDescendantMatches(scene: Scene, group: ImageGroup, filter: OutlineFilter, visited = new Set<string>()): boolean {
  if (visited.has(group.id)) return false;
  const path = new Set(visited).add(group.id);
  if (outlineObjectMatches(group, 'group', filter)) return true;
  return group.members.some((member) => {
    if (member.type === 'image') {
      const item = scene.items.find((value) => value.id === member.id);
      return Boolean(item && outlineObjectMatches(item, 'image', filter));
    }
    if (member.type === 'annotation') {
      const annotation = scene.annotations.find((value) => value.id === member.id);
      return Boolean(annotation && outlineObjectMatches(annotation, 'annotation', filter));
    }
    const child = scene.groups.find((value) => value.id === member.id);
    return Boolean(child && groupOrDescendantMatches(scene, child, filter, path));
  });
}

export function sceneTagCatalog(scene: Scene) {
  const tags = new Map<string, string>();
  [...scene.items, ...scene.groups, ...scene.annotations].forEach((object) => {
    object.tags?.forEach((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tags.has(key)) tags.set(key, tag);
    });
  });
  return [...tags.values()].sort((left, right) => left.localeCompare(right));
}
