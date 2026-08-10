import fs from 'node:fs/promises';
import path from 'node:path';
import { DISK_IMAGE_CACHE_DEFAULT_BYTES } from '../../src/shared/imagePipelineConfig.js';

interface AssetDirectory {
  assetId: string;
  directory: string;
  bytes: number;
  usedAt: number;
}

async function directoryInfo(directory: string, assetId: string): Promise<AssetDirectory | undefined> {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return undefined; }
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return directoryInfo(target, assetId);
    if (!entry.isFile()) return undefined;
    try {
      const stat = await fs.stat(target);
      return { assetId, directory: target, bytes: stat.size, usedAt: Math.max(stat.atimeMs, stat.mtimeMs) };
    } catch { return undefined; }
  }));
  const valid = files.filter((value): value is AssetDirectory => Boolean(value));
  if (!valid.length) return { assetId, directory, bytes: 0, usedAt: 0 };
  return {
    assetId,
    directory,
    bytes: valid.reduce((total, value) => total + value.bytes, 0),
    usedAt: Math.max(...valid.map((value) => value.usedAt)),
  };
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export async function trimImagePyramidCache(options: {
  assetsRoot: string;
  temporaryRoot?: string;
  protectedAssetIds?: ReadonlySet<string>;
  recentAssetIds?: ReadonlySet<string>;
  budgetBytes?: number;
  deleteBatchSize?: number;
}) {
  if (options.temporaryRoot) await fs.rm(options.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  let entries;
  try { entries = await fs.readdir(options.assetsRoot, { withFileTypes: true }); }
  catch { return { bytes: 0, removed: 0 }; }
  const directories = (await Promise.all(entries.filter((entry) => entry.isDirectory())
    .map((entry) => directoryInfo(path.join(options.assetsRoot, entry.name), entry.name))))
    .filter((entry): entry is AssetDirectory => Boolean(entry));
  let bytes = directories.reduce((total, entry) => total + entry.bytes, 0);
  let removed = 0;
  let batch = 0;
  const protectedIds = options.protectedAssetIds ?? new Set<string>();
  const recentIds = options.recentAssetIds ?? new Set<string>();
  const candidates = directories.filter((entry) => !protectedIds.has(entry.assetId))
    .sort((left, right) => Number(recentIds.has(left.assetId)) - Number(recentIds.has(right.assetId))
      || left.usedAt - right.usedAt);
  for (const entry of candidates) {
    if (bytes <= (options.budgetBytes ?? DISK_IMAGE_CACHE_DEFAULT_BYTES)) break;
    await fs.rm(entry.directory, { recursive: true, force: true });
    bytes -= entry.bytes;
    removed += 1;
    batch += 1;
    if (batch >= (options.deleteBatchSize ?? 16)) {
      batch = 0;
      await yieldToEventLoop();
    }
  }
  return { bytes, removed };
}
