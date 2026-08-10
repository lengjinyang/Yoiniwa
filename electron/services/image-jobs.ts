export class ImageJobCanceledError extends Error {
  constructor() {
    super('图像任务已取消');
    this.name = 'ImageJobCanceledError';
  }
}

interface ImageJob {
  key: string;
  task(signal: AbortSignal): unknown;
  priority: number;
  sequence: number;
  canceled: boolean;
  active: boolean;
  controller: AbortController;
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  promise: Promise<unknown>;
}

export function createImageJobQueue({ concurrency = 2 }: { concurrency?: number } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('图像任务并发数无效');
  let pending: ImageJob[] = [];
  const inFlight = new Map<string, ImageJob>();
  let active = 0;
  let sequence = 0;
  const idleWaiters = new Set<() => void>();

  const notifyIdle = () => {
    if (active || pending.some((job) => !job.canceled)) return;
    idleWaiters.forEach((resolve) => resolve());
    idleWaiters.clear();
  };

  const runNext = () => {
    while (active < concurrency && pending.length) {
      pending.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
      const job = pending.shift();
      if (!job) break;
      if (job.canceled) {
        inFlight.delete(job.key);
        continue;
      }
      active += 1;
      job.active = true;
      Promise.resolve()
        .then(() => job.task(job.controller.signal))
        .then(
          (value) => { if (!job.canceled) job.resolve(value); },
          (error) => { if (!job.canceled) job.reject(error); },
        )
        .finally(() => {
          job.active = false;
          active -= 1;
          if (inFlight.get(job.key) === job) inFlight.delete(job.key);
          runNext();
          notifyIdle();
        });
    }
  };

  return {
    enqueue<T>(key: string, task: (signal: AbortSignal) => T | PromiseLike<T>, priority = 0): Promise<T> {
      const existing = inFlight.get(key);
      if (existing) {
        // A speculative request may become visible before it starts. Promote
        // the existing single-flight job instead of leaving the visible tile
        // behind the rest of the background queue.
        existing.priority = Math.max(existing.priority, priority);
        runNext();
        return existing.promise as Promise<T>;
      }
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const job: ImageJob = {
        key, task, priority, sequence: sequence += 1, canceled: false, active: false, controller: new AbortController(),
        resolve: resolve as (value: unknown) => void, reject, promise: promise as Promise<unknown>,
      };
      inFlight.set(key, job);
      pending.push(job);
      runNext();
      return promise;
    },
    cancel(predicate: (key: string) => boolean) {
      let canceled = 0;
      for (const [key, job] of [...inFlight.entries()]) {
        if (job.canceled || !predicate(key)) continue;
        job.canceled = true;
        job.controller.abort();
        if (inFlight.get(key) === job) inFlight.delete(key);
        job.reject(new ImageJobCanceledError());
        canceled += 1;
      }
      pending = pending.filter((job) => !job.canceled);
      notifyIdle();
      return canceled;
    },
    boost(predicate: (key: string) => boolean, priority: number) {
      let promoted = 0;
      inFlight.forEach((job, key) => {
        if (!job.canceled && predicate(key) && priority > job.priority) {
          job.priority = priority;
          promoted += 1;
        }
      });
      runNext();
      return promoted;
    },
    stats() {
      return { active, pending: pending.filter((job) => !job.canceled).length, inFlight: inFlight.size, concurrency };
    },
    whenIdle() {
      if (!active && !pending.some((job) => !job.canceled)) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
  };
}
