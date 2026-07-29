import type { ImageItem, Scene } from '../../types';
import type { CanvasCommand } from './Command';

type ImageChange = Partial<ImageItem> & { id: string };

function replaceImages(scene: Scene, replacements: ReadonlyMap<string, ImageItem>): Scene {
  return { ...scene, items: scene.items.map((item) => replacements.get(item.id) ?? item) };
}

export class ImageTransformCommand implements CanvasCommand {
  readonly label = 'transform images';
  private readonly before = new Map<string, ImageItem>();
  private readonly after = new Map<string, ImageItem>();

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
  undo(scene: Scene) { return replaceImages(scene, this.before); }
}
