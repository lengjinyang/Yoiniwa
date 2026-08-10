import { renderItems } from '../exportScene';
import type { Scene } from '../types';

export async function renderProjectPreview(scene: Scene): Promise<ArrayBuffer | undefined> {
  try {
    return await renderItems(
      scene.items,
      scene.canvas.background,
      scene.groups,
      scene.canvas.backgroundOpacity ?? 1,
      scene.visualNotes,
      { margin: 20, maxSide: 512 },
    );
  } catch {
    // A preview must never prevent the project itself from being saved.
    return undefined;
  }
}
