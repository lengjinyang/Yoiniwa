import type { PhotoshopColorSyncResult, PickedColor } from '../types';

export interface PhotoshopSyncRequest {
  color: Pick<PickedColor, 'r' | 'g' | 'b' | 'hex'> & { a?: number };
  returnFocus?: boolean;
}

interface QueueEntry extends PhotoshopSyncRequest {
  waiters: Array<{
    resolve(result: PhotoshopColorSyncResult): void;
    reject(error: unknown): void;
  }>;
}

/** Coalesce in-flight Photoshop color syncs so rapid Alt+pen picks keep the latest color. */
export function createPhotoshopSyncQueue(
  execute: (request: PhotoshopSyncRequest) => Promise<PhotoshopColorSyncResult>,
) {
  let active = false;
  let pending: QueueEntry | undefined;

  const run = async (first: QueueEntry) => {
    active = true;
    let entry: QueueEntry | undefined = first;
    while (entry) {
      try {
        const result = await execute(entry);
        entry.waiters.forEach((waiter) => waiter.resolve(result));
      } catch (error) {
        entry.waiters.forEach((waiter) => waiter.reject(error));
      }
      entry = pending;
      pending = undefined;
    }
    active = false;
  };

  return {
    enqueue(request: PhotoshopSyncRequest) {
      return new Promise<PhotoshopColorSyncResult>((resolve, reject) => {
        const waiter = { resolve, reject };
        if (active) {
          if (pending) {
            pending.color = request.color;
            pending.returnFocus = request.returnFocus;
            pending.waiters.push(waiter);
          } else pending = { ...request, waiters: [waiter] };
          return;
        }
        void run({ ...request, waiters: [waiter] });
      });
    },
  };
}
