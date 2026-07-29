import { GPU_UPLOAD_BUDGET } from './TextureConfig';

interface UploadRequest<T> {
  key: string;
  estimatedBytes: number;
  priority: number;
  upload(): Promise<T>;
}

interface QueuedUpload<T> extends UploadRequest<T> {
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export class GpuUploadQueue {
  private readonly queue: QueuedUpload<unknown>[] = [];
  private readonly promises = new Map<string, Promise<unknown>>();
  lastFrameBytes = 0;

  get length() { return this.queue.length; }

  request<T>(request: UploadRequest<T>) {
    const existing = this.promises.get(request.key) as Promise<T> | undefined;
    if (existing) return existing;
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    this.promises.set(request.key, promise);
    this.queue.push({ ...request, resolve: resolve as (value: unknown) => void, reject });
    return promise.finally(() => { if (this.promises.get(request.key) === promise) this.promises.delete(request.key); });
  }

  processFrame(now: () => number = performance.now.bind(performance)) {
    const started = now();
    let items = 0;
    let bytes = 0;
    this.queue.sort((a, b) => b.priority - a.priority);
    while (this.queue.length && items < GPU_UPLOAD_BUDGET.items) {
      const request = this.queue[0];
      if (items > 0 && bytes + request.estimatedBytes > GPU_UPLOAD_BUDGET.bytes) break;
      if (items > 0 && now() - started >= GPU_UPLOAD_BUDGET.milliseconds) break;
      this.queue.shift();
      items += 1;
      bytes += request.estimatedBytes;
      void request.upload().then(request.resolve, request.reject);
    }
    this.lastFrameBytes = bytes;
    return { items, bytes };
  }

  clear(reason = new Error('GPU upload queue was cleared')) {
    this.queue.splice(0).forEach((request) => request.reject(reason));
  }
}
