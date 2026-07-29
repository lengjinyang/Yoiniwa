import { describe, expect, it } from 'vitest';
import { createDirtyRevisionState, markRevisionSaved, updateDirtyRevision } from './dirtyRevision';

describe('dirty revision state', () => {
  it('stays dirty when a newer edit arrives while an older revision is saving', () => {
    let state = updateDirtyRevision(createDirtyRevisionState(), true, 3);
    state = updateDirtyRevision(state, true, 4);
    state = markRevisionSaved(state, 3);
    expect(state).toEqual({ latestRevision: 4, savedRevision: 3, dirty: true });
  });

  it('clears dirty only when the latest revision is saved', () => {
    let state = updateDirtyRevision(createDirtyRevisionState(), true, 3);
    state = markRevisionSaved(state, 3);
    expect(state.dirty).toBe(false);
  });
});

