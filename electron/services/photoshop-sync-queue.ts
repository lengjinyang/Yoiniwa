import type { PhotoshopColorSyncResult } from '../../src/types.js';

export interface PhotoshopSyncRequest {
  color: { r: number; g: number; b: number; hex: string };
  returnFocus: boolean;
}

interface QueueEntry extends PhotoshopSyncRequest {
  waiters: Array<(result: PhotoshopColorSyncResult) => void>;
}

export function createPhotoshopSyncQueue(
  execute: (request: PhotoshopSyncRequest) => Promise<PhotoshopColorSyncResult>,
) {
  let active = false;
  let pending: QueueEntry | undefined;

  const run = async (entry: QueueEntry) => {
    active = true;
    const result = await execute(entry);
    entry.waiters.forEach((waiter) => waiter(result));
    const next = pending;
    pending = undefined;
    if (next) await run(next);
    else active = false;
  };

  return {
    enqueue(request: PhotoshopSyncRequest) {
      return new Promise<PhotoshopColorSyncResult>((resolve) => {
        if (active) {
          if (pending) {
            pending.color = request.color;
            pending.returnFocus = request.returnFocus;
            pending.waiters.push(resolve);
          } else pending = { ...request, waiters: [resolve] };
          return;
        }
        void run({ ...request, waiters: [resolve] });
      });
    },
  };
}
