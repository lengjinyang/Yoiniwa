import { describe, expect, it } from 'vitest';
import { migrateProjectScene } from '../canvas/persistence/ProjectMigration';
import { deleteSceneSelection } from '../domain/sceneCommands';
import { createScene } from '../scene';
import { captureSceneSelection, pasteScenePayload } from '../sceneClipboard';
import type { BrushVisualMark, ImageItem } from '../types';
import { appendBrushSample, simplifyBrushPoints, widthFactorForSample } from './BrushEngine';
import { eraseStroke, eraserHitsArrow } from './EraserEngine';
import { imageSourceToWorld, worldToImageSource } from './VisualNoteGeometry';

const image: ImageItem = {
  id: 'image', name: 'image', sourceType: 'file', naturalWidth: 1000, naturalHeight: 500,
  x: 100, y: 80, width: 400, height: 200, rotation: 30, flipX: true, flipY: false,
  opacity: 1, zIndex: 0, locked: false, crop: { x: 100, y: 50, width: 800, height: 400 },
};

const stroke = (points = Array.from({ length: 11 }, (_, x) => ({ x: x * 10, y: 0, widthFactor: 1 }))): BrushVisualMark => ({
  id: 'stroke', kind: 'stroke', anchor: { type: 'scene' }, points, createdAt: 1,
  style: { color: '#c59b62', opacity: 0.8, width: 'medium', baseWidth: 6 },
});

describe('visual note brush engine', () => {
  it('maps pressure and mouse speed into bounded width without affecting fixed mode', () => {
    expect(widthFactorForSample({ x: 0, y: 0, pressure: 0, time: 0, pointerType: 'mouse' }, undefined, false)).toBe(1);
    expect(widthFactorForSample({ x: 0, y: 0, pressure: 1, time: 0, pointerType: 'pen' }, undefined, true)).toBeCloseTo(1.65);
    const previous = { x: 0, y: 0, pressure: 0, time: 0, pointerType: 'mouse' };
    const slow = widthFactorForSample({ ...previous, x: 1, time: 20 }, previous, true);
    const fast = widthFactorForSample({ ...previous, x: 30, time: 5 }, previous, true);
    expect(slow).toBeGreaterThan(fast);
  });

  it('filters duplicate samples and deterministically simplifies a stroke', () => {
    const points: Array<{ x: number; y: number; widthFactor: number }> = [];
    const raw = { x: 1, y: 2, pressure: 0.5, time: 1, pointerType: 'pen' };
    expect(appendBrushSample(points, raw, undefined, true, 2)).toBe(true);
    expect(appendBrushSample(points, { ...raw, x: 1.5 }, raw, true, 2)).toBe(false);
    expect(simplifyBrushPoints([{ x: 0, y: 0, widthFactor: 1 }, { x: 5, y: 0.1, widthFactor: 0.8 }, { x: 10, y: 0, widthFactor: 1 }], 0.5)).toHaveLength(2);
  });
});

describe('visual note coordinates and eraser', () => {
  it('round trips image source coordinates across crop, rotation and flip transforms', () => {
    const source = { x: 420, y: 210 };
    const world = imageSourceToWorld(image, source);
    const restored = worldToImageSource(image, world);
    expect(restored.x).toBeCloseTo(source.x, 6);
    expect(restored.y).toBeCloseTo(source.y, 6);
  });

  it('splits a stroke in the middle while preserving style and ownership', () => {
    const result = eraseStroke(stroke(), [], [{ x: 50, y: -10 }, { x: 50, y: 10 }], 5, () => 'split');
    expect(result).toHaveLength(2);
    expect(result.map((value) => value.id)).toEqual(['stroke', 'split']);
    expect(result.every((value) => value.anchor.type === 'scene' && value.style.color === '#c59b62')).toBe(true);
  });

  it('removes an arrow when the eraser crosses its shaft or touches its head', () => {
    const arrow = {
      id: 'arrow', kind: 'arrow' as const, anchor: { type: 'scene' as const }, createdAt: 1,
      start: { x: 0, y: 0, widthFactor: 1 }, end: { x: 100, y: 0, widthFactor: 1 },
      style: { color: '#c59b62', opacity: 0.8, width: 'medium' as const, baseWidth: 4 },
    };
    expect(eraserHitsArrow(arrow, [], [{ x: 50, y: -20 }, { x: 50, y: 20 }], 4)).toBe(true);
    expect(eraserHitsArrow(arrow, [], [{ x: 106, y: 5 }], 2)).toBe(true);
    expect(eraserHitsArrow(arrow, [], [{ x: 50, y: 40 }], 4)).toBe(false);
  });
});

describe('visual note persistence lifecycle', () => {
  it('migrates v2 to v3 and intentionally drops legacy annotations', () => {
    const migrated = migrateProjectScene({ format: 'refcanvas', version: 2, annotations: [{ id: 'legacy' }],
      name: 'old', savedAt: '', viewport: { x: 0, y: 0, scale: 1 }, canvas: {}, assets: {}, items: [], groups: [] });
    expect(migrated?.version).toBe(3);
    expect(migrated?.visualNotes).toEqual({ visible: true, nextNumber: 1, marks: [] });
    expect('annotations' in (migrated as unknown as Record<string, unknown>)).toBe(false);
  });

  it('cascades attached marks when an image is deleted', () => {
    const scene = createScene(); scene.items = [{ ...image, rotation: 0, flipX: false }];
    scene.visualNotes.marks = [{ ...stroke(), anchor: { type: 'image', imageId: image.id } }];
    deleteSceneSelection(scene, [image.id]);
    expect(scene.visualNotes.marks).toEqual([]);
  });

  it('copies attached marks with a remapped image identity', () => {
    const scene = createScene(); scene.items = [{ ...image, rotation: 0, flipX: false }];
    scene.visualNotes.marks = [{ ...stroke(), anchor: { type: 'image', imageId: image.id } }];
    const payload = captureSceneSelection(scene, [image.id]);
    expect(payload).toBeDefined();
    const result = pasteScenePayload(scene, payload!, 30);
    const copiedId = result.imageIds[0];
    expect(scene.visualNotes.marks.some((mark) => mark.anchor.type === 'image' && mark.anchor.imageId === copiedId)).toBe(true);
  });
});
