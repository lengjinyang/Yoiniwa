import { describe, expect, it } from 'vitest';
import { shouldAutoPhotoshopRoundTrip, shouldUseFocuslessPhotoshopPicker } from './photoshopIntegration';

describe('Photoshop round-trip focus policy', () => {
  it('requires both a locked and always-on-top reference window', () => {
    expect(shouldAutoPhotoshopRoundTrip({ locked: false, alwaysOnTop: false })).toBe(false);
    expect(shouldAutoPhotoshopRoundTrip({ locked: true, alwaysOnTop: false })).toBe(false);
    expect(shouldAutoPhotoshopRoundTrip({ locked: false, alwaysOnTop: true })).toBe(false);
    expect(shouldAutoPhotoshopRoundTrip({ locked: true, alwaysOnTop: true })).toBe(true);
    expect(shouldAutoPhotoshopRoundTrip({ locked: true, alwaysOnTop: true }, false)).toBe(false);
  });

  it('uses a non-activating window only in locked topmost reference mode', () => {
    expect(shouldUseFocuslessPhotoshopPicker({ locked: false, alwaysOnTop: false })).toBe(false);
    expect(shouldUseFocuslessPhotoshopPicker({ locked: true, alwaysOnTop: false })).toBe(false);
    expect(shouldUseFocuslessPhotoshopPicker({ locked: false, alwaysOnTop: true })).toBe(false);
    expect(shouldUseFocuslessPhotoshopPicker({ locked: true, alwaysOnTop: true })).toBe(true);
  });
});
