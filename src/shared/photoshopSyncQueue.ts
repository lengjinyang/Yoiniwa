import type { PhotoshopColorSyncResult, PickedColor } from '../types';

export interface PhotoshopSyncRequest {
  color: Pick<PickedColor, 'r' | 'g' | 'b' | 'hex'> & { a?: number };
  returnFocus?: boolean;
}

interface QueueEntry extends PhotoshopSyncRequest {
  waiters: Array<(result: PhotoshopColorSyncResult) => void>;
}

/** Coalesce in-flight Photoshop color syncs so rapid Alt+pen picks keep the latest color. */
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
