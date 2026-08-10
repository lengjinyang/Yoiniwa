import type { Scene } from '../../types';
import { migrateProjectScene } from './ProjectMigration';

export function loadProjectScene(input: unknown): Scene | undefined {
  const scene = migrateProjectScene(input);
  if (!scene || !Number.isFinite(scene.viewport.x) || !Number.isFinite(scene.viewport.y)
    || !Number.isFinite(scene.viewport.scale) || scene.viewport.scale <= 0) return undefined;
  if (scene.items.some((item) => typeof item.id !== 'string' || !Number.isFinite(item.zIndex)
    || !Number.isFinite(item.width) || !Number.isFinite(item.height))) return undefined;
  return scene;
}
