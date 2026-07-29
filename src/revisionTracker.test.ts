import { describe, expect, it } from 'vitest';
import { createRevisionTracker } from './revisionTracker';

describe('revision tracker', () => {
  it('keeps an older save dirty after a later edit', () => {
    const revisions = createRevisionTracker();
    const savedRevision = revisions.advance();
    revisions.advance();
    expect(revisions.matches(savedRevision)).toBe(false);
  });

  it('treats the current revision as saved', () => {
    const revisions = createRevisionTracker();
    const savedRevision = revisions.advance();
    expect(revisions.matches(savedRevision)).toBe(true);
  });

  it('advances for a viewport mutation while a save is in flight', () => {
    const revisions = createRevisionTracker();
    const savedRevision = revisions.advance();
    revisions.advance();
    expect(revisions.current()).toBe(savedRevision + 1);
    expect(revisions.matches(savedRevision)).toBe(false);
  });
});
