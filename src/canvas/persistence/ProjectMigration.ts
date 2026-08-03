import type { Scene } from '../../types';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function migrateProjectScene(input: unknown): Scene | undefined {
  const source = record(input);
  if (!source || source.format !== 'refcanvas' || (source.version !== 1 && source.version !== 2)) return undefined;
  const migrated = structuredClone(source);
  migrated.version = 2;
  migrated.name = typeof migrated.name === 'string' ? migrated.name : '未命名画板';
  migrated.savedAt = typeof migrated.savedAt === 'string' ? migrated.savedAt : new Date(0).toISOString();
  migrated.viewport = record(migrated.viewport) ?? { x: 0, y: 0, scale: 1 };
  migrated.canvas = { background: '#121315', padding: 20, snap: true, includeBackgroundOnExport: true, ...record(migrated.canvas) };
  migrated.assets = record(migrated.assets) ?? {};
  migrated.items = Array.isArray(migrated.items) ? migrated.items.map((value) => {
    const item = record(value) ?? {};
    return { rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
      crop: { x: 0, y: 0, width: Number(item.naturalWidth) || 1, height: Number(item.naturalHeight) || 1 }, ...item };
  }) : [];
  migrated.groups = Array.isArray(migrated.groups) ? migrated.groups : [];
  migrated.annotations = Array.isArray(migrated.annotations) ? migrated.annotations : [];
  return migrated as unknown as Scene;
}
