import { describe, expect, it } from 'vitest';
import { annotationBounds, exportVisibility } from './exportScene';
import type { AnnotationItem, ImageGroup } from './types';

const base = { id: 'annotation', color: '#fff', strokeWidth: 4 } as const;

describe('annotation bounds', () => {
  it('contains freehand strokes including their stroke radius', () => {
    const annotation: AnnotationItem = { ...base, type: 'pen', points: [10, 20, 40, 60] };
    expect(annotationBounds(annotation)).toEqual({ x: 8, y: 18, width: 34, height: 44 });
  });

  it('leaves room for arrow heads so export does not clip them', () => {
    const annotation: AnnotationItem = { ...base, type: 'arrow', points: [10, 20, 40, 60] };
    expect(annotationBounds(annotation)).toEqual({ x: -6, y: 4, width: 62, height: 72 });
  });

  it('contains rectangular marks', () => {
    const annotation: AnnotationItem = { ...base, type: 'rectangle', x: 10, y: 20, width: 30, height: 40 };
    expect(annotationBounds(annotation)).toEqual({ x: 8, y: 18, width: 34, height: 44 });
  });
});

const group = (id: string, members: ImageGroup['members'] = []): ImageGroup => ({
  id, name: id, x: 0, y: 0, width: 200, height: 120,
  color: '#536778', opacity: 0.2, titleColor: '#fff', collapsed: false,
  sizeLocked: false, contentsHidden: false, members,
});

describe('group export visibility', () => {
  it('keeps a hidden-content frame visible while hiding all recursive members', () => {
    const child = group('child', [{ type: 'annotation', id: 'mark' }]);
    const parent = group('parent', [{ type: 'image', id: 'image' }, { type: 'group', id: child.id }]);
    parent.contentsHidden = true;

    const visibility = exportVisibility([parent, child]);

    expect(visibility.hiddenGroups.has(parent.id)).toBe(false);
    expect(visibility.hiddenGroups.has(child.id)).toBe(true);
    expect(visibility.hiddenImages.has('image')).toBe(true);
    expect(visibility.hiddenAnnotations.has('mark')).toBe(true);
  });

  it('does not hide members for an expanded visible frame', () => {
    const frame = group('frame', [{ type: 'image', id: 'image' }]);
    const visibility = exportVisibility([frame]);
    expect(visibility.hiddenImages.size).toBe(0);
    expect(visibility.hiddenGroups.size).toBe(0);
  });
});
