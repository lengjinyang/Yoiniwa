import { describe, expect, it } from 'vitest';
import type { ImageItem } from '../../types';
import { desiredImageMip, mipWithHysteresis } from './MipSelector';

const item = { width: 400, height: 200, naturalWidth: 4000, naturalHeight: 2000, rotation: 0 } as ImageItem;

describe('V2 mip selection', () => {
  it('includes DPR and oversampling and chooses the smallest covering mip', () => {
    expect(desiredImageMip(item, { x: 0, y: 0, scale: 1 }, 1)).toBe(512);
    expect(desiredImageMip(item, { x: 0, y: 0, scale: 1 }, 2)).toBe(1024);
  });

  it('upgrades immediately during motion and delays downgrades until rest', () => {
    expect(mipWithHysteresis({ desired: 2048, required: 1300, state: { displayedMip: 1024 }, now: 0, cameraMoving: true }).mip).toBe(2048);
    expect(mipWithHysteresis({ desired: 2048, required: 1300, state: { displayedMip: 1024 }, now: 0, cameraMoving: false }).mip).toBe(2048);
    expect(mipWithHysteresis({ desired: 512, required: 400, state: { displayedMip: 2048 }, now: 0, cameraMoving: true }).mip).toBe(2048);
    const waiting = mipWithHysteresis({ desired: 512, required: 400, state: { displayedMip: 1024 }, now: 0, cameraMoving: false });
    expect(waiting.mip).toBe(1024);
    expect(mipWithHysteresis({ desired: 512, required: 400, state: waiting.state, now: 301, cameraMoving: false }).mip).toBe(512);
  });
});
