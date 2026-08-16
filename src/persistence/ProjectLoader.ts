import type { Scene } from '../types';
import { normalizeScene } from '../domain/scene';
import { migrateProjectScene } from './ProjectMigration';

export function loadProjectScene(input: unknown): Scene | undefined {
  const migrated = migrateProjectScene(input);
  if (!migrated || !Number.isFinite(migrated.viewport.x) || !Number.isFinite(migrated.viewport.y)
    || !Number.isFinite(migrated.viewport.scale) || migrated.viewport.scale <= 0) return undefined;
  if (migrated.items.some((item) => typeof item.id !== 'string' || !Number.isFinite(item.zIndex)
    || !Number.isFinite(item.width) || !Number.isFinite(item.height))) return undefined;
  return normalizeScene(migrated);
}
