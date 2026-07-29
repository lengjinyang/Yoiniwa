import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDerivedCache } from '../electron/services/derived-cache.js';

describe('derived cache', () => {
  it('writes and reads an atomically addressed derivative', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'refcanvas-cache-'));
    try {
      const cache = createDerivedCache(directory);
      const target = await cache.writeAtomic('asset:thumb:256', Buffer.from('thumbnail'));
      expect(await readFile(target, 'utf8')).toBe('thumbnail');
      expect((await cache.read('asset:thumb:256', '.png')).toString()).toBe('thumbnail');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('trims least recently used derivatives to the configured disk budget', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'refcanvas-cache-'));
    try {
      const cache = createDerivedCache(directory, 'v1', 5);
      const first = await cache.writeAtomic('first', Buffer.from('1234'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await cache.writeAtomic('second', Buffer.from('5678'));
      await cache.flush();
      await expect(readFile(first)).rejects.toThrow();
      expect((await readFile(second, 'utf8'))).toBe('5678');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
