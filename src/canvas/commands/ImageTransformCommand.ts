import type { Scene, SceneItem, SceneItemPatch } from '../../types';
import type { CanvasCommand } from './Command';

type ImageChange = SceneItemPatch;

function replaceImages(scene: Scene, replacements: ReadonlyMap<string, SceneItem>): Scene {
  return { ...scene, items: scene.items.map((item) => replacements.get(item.id) ?? item) };
}

export class ImageTransformCommand implements CanvasCommand {
  readonly label = 'transform images';
  private readonly before = new Map<string, SceneItem>();
  private readonly after = new Map<string, SceneItem>();

  constructor(scene: Scene, changes: ImageChange[]) {
    const changesById = new Map(changes.map((change) => [change.id, change]));
    scene.items.forEach((item) => {
      const change = changesById.get(item.id);
      if (!change) return;
      this.before.set(item.id, item);
      this.after.set(item.id, { ...item, ...change, crop: item.crop });
    });
  }

  execute(scene: Scene) { return replaceImages(scene, this.after); }
  /** Inverse of execute for tests; runtime history does not call this. */
  undo(scene: Scene) { return replaceImages(scene, this.before); }
}
