import type { Scene } from '../../types';

/** Runtime-only selection, GPU handles, requests and previews never cross this boundary. */
export function serializeProjectScene(scene: Scene): Scene {
  return {
    ...scene,
    viewport: { ...scene.viewport }, canvas: { ...scene.canvas }, assets: { ...scene.assets },
    items: scene.items.map((item) => ({ ...item, crop: { ...item.crop }, tags: item.tags ? [...item.tags] : undefined })),
    groups: scene.groups.map((group) => ({ ...group, members: group.members.map((member) => ({ ...member })),
      detachedImageIds: group.detachedImageIds ? [...group.detachedImageIds] : undefined,
      tags: group.tags ? [...group.tags] : undefined })),
    annotations: scene.annotations.map((annotation) => ({ ...annotation, points: annotation.points ? [...annotation.points] : undefined,
      tags: annotation.tags ? [...annotation.tags] : undefined })),
  };
}
