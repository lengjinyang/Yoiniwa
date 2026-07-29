export interface RecentAssetEntry {
  path: string;
  name: string;
  openedAt: string;
  assetIds?: string[];
}

export function collectRecentAssetIds(recent: readonly RecentAssetEntry[] = []) {
  return new Set(recent.flatMap((entry) => entry.assetIds ?? []).filter((id) => typeof id === 'string' && id.length > 0));
}

export async function hydrateRecentAssetIds(
  recent: readonly RecentAssetEntry[],
  readAssetIds: (filePath: string) => Promise<string[]>,
) {
  return Promise.all(recent.map(async (entry) => {
    if (Array.isArray(entry.assetIds)) return entry;
    try { return { ...entry, assetIds: await readAssetIds(entry.path) }; }
    catch { return { ...entry, assetIds: [] }; }
  }));
}
