import type { ImageGroup, Scene, SceneItem, SceneItemPatch, VisualNotesState } from '../../types';
import type { SceneNode } from './SceneNode';
import { SpatialIndex } from './SpatialIndex';
import { fitAutoGroupsToContents } from '../../domain/scene';
import { moveSceneMark } from '../../visualNotes/VisualNoteGeometry';
import { pointInImage } from '../selection/HitTestService';

export class SceneStore {
  private scene: Scene;
  private readonly nodes = new Map<string, SceneNode>();
  private readonly spatial = new SpatialIndex();
  private hiddenImages = new Set<string>();
  private hiddenGroups = new Set<string>();
  private hiddenMarks = new Set<string>();

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
  imageAtPoint(point: { x: number; y: number }) {
    const candidates = this.spatial.query({ x: point.x, y: point.y, width: 0, height: 0 });
    let topmost: SceneItem | undefined;
    candidates.forEach((id) => {
      if (this.hiddenImages.has(id)) return;
      const node = this.nodes.get(id);
      if (!node || node.kind !== 'image' || !pointInImage(node.value, point)) return;
      if (!topmost || node.value.zIndex > topmost.zIndex) topmost = node.value;
    });
    return topmost;
  }
  groups() { return this.scene.groups.map((group) => this.hiddenGroups.has(group.id) ? { ...group, hidden: true } : group); }
  renderScene(): Scene {
    return { ...this.scene,
      items: this.scene.items.map((item) => this.hiddenImages.has(item.id) ? { ...item, hidden: true } : item),
      groups: this.scene.groups.map((group) => this.hiddenGroups.has(group.id) ? { ...group, hidden: true } : group),
      visualNotes: {
        ...this.scene.visualNotes,
        marks: this.scene.visualNotes.marks.filter((mark) => !this.hiddenMarks.has(mark.id)),
      },
    };
  }
  queryImages(bounds: { x: number; y: number; width: number; height: number }) {
    const visible = this.spatial.query(bounds);
    this.hiddenImages.forEach((id) => visible.delete(id));
    return visible;
  }

  previewImageChanges(changes: Array<SceneItemPatch>) {
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

  previewVisualNotes(visualNotes: VisualNotesState) {
    this.scene = { ...this.scene, visualNotes };
  }

  previewGroupMove(id: string, deltaX: number, deltaY: number) {
    const groupIds = new Set<string>(); const imageIds = new Set<string>(); const markIds = new Set<string>();
    const collect = (groupId: string) => {
      if (groupIds.has(groupId)) return;
      groupIds.add(groupId);
      this.scene.groups.find((group) => group.id === groupId)?.members.forEach((member) => {
        if (member.type === 'image') imageIds.add(member.id);
        else if (member.type === 'group') collect(member.id);
        else if (member.type === 'mark') markIds.add(member.id);
      });
    };
    collect(id);
    const next: Scene = {
      ...this.scene,
      items: this.scene.items.map((item) => imageIds.has(item.id) ? { ...item, x: item.x + deltaX, y: item.y + deltaY } : item),
      groups: this.scene.groups.map((group) => ({ ...group, members: group.members.map((member) => ({ ...member })),
        ...(groupIds.has(group.id) ? { x: group.x + deltaX, y: group.y + deltaY } : {}) })),
      visualNotes: {
        ...this.scene.visualNotes,
        marks: this.scene.visualNotes.marks.map((mark) => markIds.has(mark.id) ? moveSceneMark(mark, deltaX, deltaY) : mark),
      },
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
    this.scene.items.forEach((value) => this.nodes.set(value.id, { kind: 'image', id: value.id, value }));
    this.scene.groups.forEach((value: ImageGroup) => this.nodes.set(value.id, { kind: 'group', id: value.id, value }));
    this.hiddenImages = new Set(); this.hiddenGroups = new Set(); this.hiddenMarks = new Set();
    const visited = new Set<string>();
    const hideMembers = (groupId: string) => {
      if (visited.has(groupId)) return;
      visited.add(groupId);
      this.scene.groups.find((group) => group.id === groupId)?.members.forEach((member) => {
        if (member.type === 'image') this.hiddenImages.add(member.id);
        else if (member.type === 'group') { this.hiddenGroups.add(member.id); hideMembers(member.id); }
        else if (member.type === 'mark') this.hiddenMarks.add(member.id);
      });
    };
    this.scene.groups.filter((group) => group.hidden || group.contentsHidden || group.collapsed).forEach((group) => hideMembers(group.id));
    this.spatial.rebuild(this.scene.items);
  }
}
