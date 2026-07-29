import { describe, expect, it } from 'vitest';
import { eraseAnnotationsAt } from './annotationEraser';
import type { AnnotationItem } from './types';

describe('paint eraser', () => {
  it('cuts a freehand stroke into separate surviving segments', () => {
    const pen: AnnotationItem = { id: 'pen', type: 'pen', color: '#fff', strokeWidth: 2, points: [0, 0, 10, 0, 20, 0, 30, 0, 40, 0] };
    let part = 0;
    const result = eraseAnnotationsAt([pen], 20, 0, 4, () => `part-${++part}`);
    expect(result.changed).toBe(true);
    expect(result.annotations).toHaveLength(2);
    expect(result.annotations[0].points).toEqual([0, 0, 10, 0]);
    expect(result.annotations[1].points).toEqual([30, 0, 40, 0]);
    expect(result.splitMembers).toEqual([{ sourceId: 'pen', newId: 'part-1' }]);
  });

  it('removes a shape when the brush touches its outline', () => {
    const rectangle: AnnotationItem = { id: 'box', type: 'rectangle', color: '#fff', strokeWidth: 2, x: 10, y: 10, width: 50, height: 30 };
    expect(eraseAnnotationsAt([rectangle], 10, 25, 5).removedIds).toEqual(['box']);
  });
});
