import { describe, expect, it } from 'vitest';
import { normalizeTags, tagMatches } from './tags';

describe('tags', () => {
  it('trims, case-insensitively deduplicates, and removes empty values', () => {
    expect(normalizeTags(['  Concept ', '', 'concept', '人物'])).toEqual(['Concept', '人物']);
  });

  it('limits tags and tag length', () => {
    const long = 'a'.repeat(80);
    const tags = normalizeTags(Array.from({ length: 40 }, (_, index) => `${index}-${long}`));
    expect(tags).toHaveLength(32);
    expect(Array.from(tags![0]).length).toBe(64);
  });

  it('matches tag search case-insensitively', () => {
    expect(tagMatches(['环境设计', '角色'], '环境')).toBe(true);
    expect(tagMatches(['环境设计'], '角色')).toBe(false);
  });
});
