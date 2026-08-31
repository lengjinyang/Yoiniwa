import type { Scene } from '../types';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function migrateProjectScene(input: unknown): Scene | undefined {
  const source = record(input);
  if (!source || source.format !== 'refcanvas' || ![1, 2, 3, 4].includes(Number(source.version))) return undefined;
  const migrated = structuredClone(source);
  migrated.version = 4;
  migrated.name = typeof migrated.name === 'string' ? migrated.name : '未命名画板';
  migrated.savedAt = typeof migrated.savedAt === 'string' ? migrated.savedAt : new Date(0).toISOString();
  migrated.viewport = record(migrated.viewport) ?? { x: 0, y: 0, scale: 1 };
  const migratedCanvas = record(migrated.canvas);
  const previousBackground = typeof migratedCanvas?.background === 'string' ? migratedCanvas.background.toUpperCase() : undefined;
  const normalizedCanvas: Record<string, unknown> = {
    background: '#1D1D1D', padding: 20, snap: true, includeBackgroundOnExport: true, ...migratedCanvas,
  };
  // Keep deliberate custom board colors, but move historical Yoiniwa defaults
  // to the current neutral gray requested for the canvas.
  if (previousBackground && ['#121315', '#1A1D21', '#202124'].includes(previousBackground)) {
    normalizedCanvas.background = '#1D1D1D';
  }
  migrated.canvas = normalizedCanvas;
  migrated.assets = record(migrated.assets) ?? {};
  migrated.items = Array.isArray(migrated.items) ? migrated.items.map((value) => {
    const item = record(value) ?? {};
    delete item.comment;
    delete item.contentKind;
    delete item.pose;
    return { rotation: 0, flipX: false, flipY: false, opacity: 1, zIndex: 0, locked: false,
      crop: { x: 0, y: 0, width: Number(item.naturalWidth) || 1, height: Number(item.naturalHeight) || 1 }, ...item };
  }) : [];
  migrated.groups = Array.isArray(migrated.groups) ? migrated.groups.map((value) => {
    const group = record(value) ?? {};
    return { ...group, members: Array.isArray(group.members)
      ? group.members.filter((member) => record(member)?.type !== 'annotation') : [] };
  }) : [];
  // Annotation data from older files is intentionally discarded at the load
  // boundary until the redesigned feature has a new, explicit data model.
  delete migrated.annotations;
  const notes = record(migrated.visualNotes);
  migrated.visualNotes = {
    visible: notes?.visible !== false,
    nextNumber: Math.max(1, Number(notes?.nextNumber) || 1),
    marks: Array.isArray(notes?.marks) ? notes.marks.filter((mark) => record(mark)?.kind !== 'number') : [],
  };
  return migrated as unknown as Scene;
}
