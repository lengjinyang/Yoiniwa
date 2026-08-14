import { describe, expect, it, vi } from 'vitest';
import { spaceKeyQueryFromApi } from './spaceKeyQuery';

describe('spaceKeyQueryFromApi', () => {
  it('returns undefined when the desktop API cannot query keys', () => {
    expect(spaceKeyQueryFromApi(undefined)).toBeUndefined();
    expect(spaceKeyQueryFromApi({} as Window['refCanvas'])).toBeUndefined();
  });

  it('queries Space through the desktop API', async () => {
    const isKeyDown = vi.fn(async (key: 'Space') => key === 'Space');
    const query = spaceKeyQueryFromApi({ isKeyDown } as unknown as Window['refCanvas']);
    await expect(query?.()).resolves.toBe(true);
    expect(isKeyDown).toHaveBeenCalledWith('Space');
  });
});
