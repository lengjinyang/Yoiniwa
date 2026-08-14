import { describe, expect, it } from 'vitest';
import { exportVisibility } from './exportScene';
import type { ImageGroup } from './types';

const group = (id: string, members: ImageGroup['members'] = []): ImageGroup => ({
  id, name: id, x: 0, y: 0, width: 200, height: 120,
  color: '#536778', opacity: 0.2, titleColor: '#fff', collapsed: false,
  sizeLocked: false, contentsHidden: false, members,
});

describe('group export visibility', () => {
  it('keeps a hidden-content frame visible while hiding all recursive members', () => {
    const child = group('child', [{ type: 'image', id: 'nested-image' }]);
    const parent = group('parent', [{ type: 'image', id: 'image' }, { type: 'group', id: child.id }]);
    parent.contentsHidden = true;

    const visibility = exportVisibility([parent, child]);

    expect(visibility.hiddenGroups.has(parent.id)).toBe(false);
    expect(visibility.hiddenGroups.has(child.id)).toBe(true);
    expect(visibility.hiddenImages.has('image')).toBe(true);
    expect(visibility.hiddenImages.has('nested-image')).toBe(true);
  });

  it('does not hide members for an expanded visible frame', () => {
    const frame = group('frame', [{ type: 'image', id: 'image' }]);
    const visibility = exportVisibility([frame]);
    expect(visibility.hiddenImages.size).toBe(0);
    expect(visibility.hiddenGroups.size).toBe(0);
  });
});
