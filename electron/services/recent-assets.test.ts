import { describe, expect, it } from 'vitest';
import { collectRecentAssetIds, hydrateRecentAssetIds } from './recent-assets.js';

describe('recent scene asset index', () => {
  it('collects unique asset identities without reading scene packages again', () => {
    const ids = collectRecentAssetIds([
      { path: 'a', name: 'a', openedAt: '', assetIds: ['one', 'two'] },
      { path: 'b', name: 'b', openedAt: '', assetIds: ['two', 'three'] },
    ]);
    expect([...ids]).toEqual(['one', 'two', 'three']);
  });

  it('hydrates legacy entries and isolates unreadable projects', async () => {
    const result = await hydrateRecentAssetIds([
      { path: 'old.refcanvas', name: 'old', openedAt: '' },
      { path: 'missing.refcanvas', name: 'missing', openedAt: '' },
    ], async (filePath) => {
      if (filePath.startsWith('missing')) throw new Error('missing');
      return ['asset-a'];
    });
    expect(result.map((entry) => entry.assetIds)).toEqual([['asset-a'], []]);
  });
});
