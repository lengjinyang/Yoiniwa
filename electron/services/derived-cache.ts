import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

interface CacheFile {
  path: string;
  size: number;
  usedAt: number;
}

export function createDerivedCache(rootDir: string, schemaVersion = 'v1', budgetBytes = 512 * 1024 * 1024) {
  const root = path.join(rootDir, 'derived-cache', schemaVersion);
  const pathFor = (key: string, extension = '.png') => path.join(root, `${createHash('sha256').update(key).digest('hex')}${extension}`);
  let trimTimer: NodeJS.Timeout | undefined;
  let trimQueue: Promise<unknown> = Promise.resolve();

  const trim = async (limit = budgetBytes) => {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch { return { bytes: 0, removed: 0 }; }
    const files = (await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const filePath = path.join(root, entry.name);
      try {
        const stat = await fs.stat(filePath);
        return { path: filePath, size: stat.size, usedAt: Math.max(stat.atimeMs, stat.mtimeMs) };
      } catch { return undefined; }
    }))).filter((file): file is CacheFile => Boolean(file));
    let bytes = files.reduce((total, file) => total + file.size, 0);
    let removed = 0;
    for (const file of files.sort((left, right) => left.usedAt - right.usedAt)) {
      if (bytes <= limit) break;
      await fs.rm(file.path, { force: true });
      bytes -= file.size;
      removed += 1;
    }
    return { bytes, removed };
  };

  const scheduleTrim = () => {
    if (trimTimer) return;
    trimTimer = setTimeout(() => {
      trimTimer = undefined;
      trimQueue = trimQueue.then(() => trim()).catch(() => undefined);
    }, 250);
    trimTimer.unref?.();
  };

  const flush = async () => {
    if (trimTimer) {
      clearTimeout(trimTimer);
      trimTimer = undefined;
      trimQueue = trimQueue.then(() => trim()).catch(() => undefined);
    }
    await trimQueue;
  };

  return {
    async read(key: string, extension = '.png') {
      const target = pathFor(key, extension);
      const buffer = await fs.readFile(target);
      const now = new Date();
      void fs.utimes(target, now, now).catch(() => undefined);
      return buffer;
    },
    async remove(key: string, extension = '.png') {
      await fs.rm(pathFor(key, extension), { force: true });
    },
    async writeAtomic(key: string, buffer: Uint8Array, extension = '.png') {
      const target = pathFor(key, extension);
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.writeFile(temp, buffer);
        try {
          await fs.rename(temp, target);
        } catch {
          await fs.rm(target, { force: true });
          await fs.rename(temp, target);
        }
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
      scheduleTrim();
      return target;
    },
    noteExternalWrite() { scheduleTrim(); },
    flush,
    trim,
    pathFor,
  };
}
