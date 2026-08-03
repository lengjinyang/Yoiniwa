import type { AnnotationItem, ImageGroup, ImageItem, Scene } from '../../types';
import type { SceneNode } from './SceneNode';
import { SpatialIndex } from './SpatialIndex';
import { fitAutoGroupsToContents } from '../../scene';

export class SceneStore {
  private scene: Scene;
  private readonly nodes = new Map<string, SceneNode>();
  private readonly spatial = new SpatialIndex();
  private hiddenImages = new Set<string>();
  private hiddenAnnotations = new Set<string>();
  private hiddenGroups = new Set<string>();

  constructor(scene: Scene) {
    this.scene = scene;
    this.rebuildIndex();
  }

  replace(scene: Scene) {
    this.scene = scene;
    this.rebuildIndex();
  }

  snapshot() { return this.scene; }
  node(id: string) { return this.nodes.get(id); }
  images() { return this.scene.items.map((item) => this.hiddenImages.has(item.id) ? { ...item, hidden: true } : item).sort((a, b) => a.zIndex - b.zIndex); }
  groups() { return this.scene.groups.map((group) => this.hiddenGroups.has(group.id) ? { ...group, hidden: true } : group); }
  annotations() { return this.scene.annotations.map((item) => this.hiddenAnnotations.has(item.id) ? { ...item, hidden: true } : item); }
  renderScene(): Scene {
    return { ...this.scene,
      items: this.scene.items.map((item) => this.hiddenImages.has(item.id) ? { ...item, hidden: true } : item),
      annotations: this.scene.annotations.map((item) => this.hiddenAnnotations.has(item.id) ? { ...item, hidden: true } : item),
      groups: this.scene.groups.map((group) => this.hiddenGroups.has(group.id) ? { ...group, hidden: true } : group),
    };
  }
  queryImages(bounds: { x: number; y: number; width: number; height: number }) {
    const visible = this.spatial.query(bounds);
    this.hiddenImages.forEach((id) => visible.delete(id));
    return visible;
  }

  previewImageChanges(changes: Array<Partial<ImageItem> & { id: string }>) {
    const byId = new Map(changes.map((change) => [change.id, change]));
    const next: Scene = {
      ...this.scene,
      groups: this.cloneGroups(),
      items: this.scene.items.map((item) => {
        const change = byId.get(item.id);
        return change ? { ...item, ...change, crop: item.crop } : item;
      }),
    };
    fitAutoGroupsToContents(next);
    this.scene = next;
    this.rebuildIndex();
  }

  previewAnnotationMove(ids: string[], deltaX: number, deltaY: number) {
    const selected = new Set(ids);
    const next: Scene = { ...this.scene, groups: this.cloneGroups(), annotations: this.scene.annotations.map((annotation) => {
      if (!selected.has(annotation.id)) return annotation;
      if (annotation.points) return { ...annotation, points: annotation.points.map((value, index) => value + (index % 2 ? deltaY : deltaX)) };
      return { ...annotation, x: (annotation.x ?? 0) + deltaX, y: (annotation.y ?? 0) + deltaY };
    }) };
    fitAutoGroupsToContents(next);
    this.scene = next;
    this.rebuildIndex();
  }

  previewGroupMove(id: string, deltaX: number, deltaY: number) {
    const groupIds = new Set<string>(); const imageIds = new Set<string>(); const annotationIds = new Set<string>();
    const collect = (groupId: string) => {
      if (groupIds.has(groupId)) return;
      groupIds.add(groupId);
      this.scene.groups.find((group) => group.id === groupId)?.members.forEach((member) => {
        if (member.type === 'image') imageIds.add(member.id);
        else if (member.type === 'annotation') annotationIds.add(member.id);
        else if (member.type === 'group') collect(member.id);
      });
    };
    collect(id);
    const next: Scene = {
      ...this.scene,
      items: this.scene.items.map((item) => imageIds.has(item.id) ? { ...item, x: item.x + deltaX, y: item.y + deltaY } : item),
      annotations: this.scene.annotations.map((annotation) => {
        if (!annotationIds.has(annotation.id)) return annotation;
        if (annotation.points) return { ...annotation, points: annotation.points.map((value, index) => value + (index % 2 ? deltaY : deltaX)) };
        return { ...annotation, x: (annotation.x ?? 0) + deltaX, y: (annotation.y ?? 0) + deltaY };
      }),
      groups: this.scene.groups.map((group) => ({ ...group, members: group.members.map((member) => ({ ...member })),
        ...(groupIds.has(group.id) ? { x: group.x + deltaX, y: group.y + deltaY } : {}) })),
    };
    fitAutoGroupsToContents(next);
    this.scene = next;
    this.rebuildIndex();
  }

  previewGroupResize(id: string, bounds: { x: number; y: number; width: number; height: number }) {
    this.scene = {
      ...this.scene,
      groups: this.scene.groups.map((group) => group.id === id ? { ...group, ...bounds, autoFit: false } : group),
    };
    this.rebuildIndex();
  }

  private cloneGroups() {
    return this.scene.groups.map((group) => ({
      ...group,
      members: group.members.map((member) => ({ ...member })),
    }));
  }

  private rebuildIndex() {
    this.nodes.clear();
    this.scene.items.forEach((value: ImageItem) => this.nodes.set(value.id, { kind: 'image', id: value.id, value }));
    this.scene.groups.forEach((value: ImageGroup) => this.nodes.set(value.id, { kind: 'group', id: value.id, value }));
    this.scene.annotations.forEach((value: AnnotationItem) => this.nodes.set(value.id, { kind: 'annotation', id: value.id, value }));
    this.hiddenImages = new Set(); this.hiddenAnnotations = new Set(); this.hiddenGroups = new Set();
    const visited = new Set<string>();
    const hideMembers = (groupId: string) => {
      if (visited.has(groupId)) return;
      visited.add(groupId);
      this.scene.groups.find((group) => group.id === groupId)?.members.forEach((member) => {
        if (member.type === 'image') this.hiddenImages.add(member.id);
        else if (member.type === 'annotation') this.hiddenAnnotations.add(member.id);
        else if (member.type === 'group') { this.hiddenGroups.add(member.id); hideMembers(member.id); }
      });
    };
    this.scene.groups.filter((group) => group.hidden || group.contentsHidden || group.collapsed).forEach((group) => hideMembers(group.id));
    this.spatial.rebuild(this.scene.items);
  }
}
