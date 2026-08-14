const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;

export function normalizeTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of tags) {
    if (typeof value !== 'string') continue;
    const tag = Array.from(value.trim()).slice(0, MAX_TAG_LENGTH).join('');
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
    if (normalized.length === MAX_TAGS) break;
  }
  return normalized.length ? normalized : undefined;
}

export function tagMatches(tags: readonly string[] | undefined, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return !normalizedQuery || Boolean(tags?.some((tag) => tag.toLocaleLowerCase().includes(normalizedQuery)));
}
