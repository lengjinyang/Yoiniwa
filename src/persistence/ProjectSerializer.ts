import type { Scene } from '../types';
import { toSceneItem } from '../domain/media';

/** Runtime-only selection, GPU handles, requests and previews never cross this boundary. */
export function serializeProjectScene(scene: Scene): Scene {
  return {
    ...scene,
    viewport: { ...scene.viewport }, canvas: { ...scene.canvas }, assets: { ...scene.assets },
    items: scene.items.map((item) => toSceneItem(
      { ...item, crop: { ...item.crop }, tags: item.tags ? [...item.tags] : undefined },
      scene.assets,
    )),
    groups: scene.groups.map((group) => ({ ...group, members: group.members.map((member) => ({ ...member })),
      detachedImageIds: group.detachedImageIds ? [...group.detachedImageIds] : undefined,
      tags: group.tags ? [...group.tags] : undefined })),
    visualNotes: structuredClone(scene.visualNotes),
  };
}
