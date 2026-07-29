import type { AnnotationItem, ImageGroup, ImageItem, Scene } from '../../types';
import type { SceneNode } from './SceneNode';
import { SpatialIndex } from './SpatialIndex';

export class SceneStore {
  private scene: Scene;
  private readonly nodes = new Map<string, SceneNode>();
  private readonly spatial = new SpatialIndex();

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
  images() { return [...this.scene.items].sort((a, b) => a.zIndex - b.zIndex); }
  groups() { return this.scene.groups; }
  annotations() { return this.scene.annotations; }
  queryImages(bounds: { x: number; y: number; width: number; height: number }) { return this.spatial.query(bounds); }

  previewImageChanges(changes: Array<Partial<ImageItem> & { id: string }>) {
    const byId = new Map(changes.map((change) => [change.id, change]));
    this.scene = {
      ...this.scene,
      items: this.scene.items.map((item) => {
        const change = byId.get(item.id);
        return change ? { ...item, ...change, crop: item.crop } : item;
      }),
    };
    this.rebuildIndex();
  }

  private rebuildIndex() {
    this.nodes.clear();
    this.scene.items.forEach((value: ImageItem) => this.nodes.set(value.id, { kind: 'image', id: value.id, value }));
    this.scene.groups.forEach((value: ImageGroup) => this.nodes.set(value.id, { kind: 'group', id: value.id, value }));
    this.scene.annotations.forEach((value: AnnotationItem) => this.nodes.set(value.id, { kind: 'annotation', id: value.id, value }));
    this.spatial.rebuild(this.scene.items);
  }
}
