import { describe, expect, it } from 'vitest';
import { applyLayout } from './layout';
import { itemBounds } from './scene';
import { createStressScene } from './stressScene';
import { SpatialIndex } from './viewportCulling';

describe('2,000 object stress fixture', () => {
  it('uses a small shared resource pool while retaining varied canvas metadata', () => {
    const scene = createStressScene();
    expect(scene.items).toHaveLength(2000);
    expect(Object.keys(scene.assets)).toHaveLength(40);
    expect(scene.groups).toHaveLength(80);
    expect(scene.items.filter((item) => item.comment)).toHaveLength(118);
    expect(new Set(scene.items.map((item) => item.rotation)).size).toBeGreaterThan(10);
  });

  it('queries and packs 2,000 objects without quadratic rendering work', () => {
    const scene = createStressScene();
    const started = performance.now();
    const index = new SpatialIndex(scene.items.map((item) => ({ id: item.id, ...itemBounds(item) })));
    const visible = index.query({ x: 0, y: 0, width: 1400, height: 900 });
    const packed = applyLayout(scene.items, 'pack', 0, 1.6);
    const elapsed = performance.now() - started;
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(200);
    expect(packed).toHaveLength(2000);
    expect(elapsed).toBeLessThan(1000);
  });
});

