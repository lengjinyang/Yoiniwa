import { describe, expect, it, vi } from 'vitest';
import { imageResourceBoostFromApi } from './imageResourceBoost';

describe('imageResourceBoostFromApi', () => {
  it('returns undefined when the desktop API has no boost hook', () => {
    expect(imageResourceBoostFromApi(undefined)).toBeUndefined();
    expect(imageResourceBoostFromApi({} as Window['refCanvas'])).toBeUndefined();
  });

  it('forwards url and priority to the desktop API', () => {
    const boostImageResource = vi.fn();
    const boost = imageResourceBoostFromApi({ boostImageResource } as unknown as Window['refCanvas']);
    boost?.('refcanvas-asset://asset', 40);
    expect(boostImageResource).toHaveBeenCalledWith('refcanvas-asset://asset', 40);
  });
});
