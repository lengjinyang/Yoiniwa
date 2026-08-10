interface ScheduledRequest<T> {
  key: string;
  generation: number;
  priority: number;
  run(): Promise<T>;
}

interface Waiter {
  priority: number;
  resolve(): void;
}

export class StaleTextureRequestError extends Error {}

const DEFAULT_MAX_CONCURRENT = 4;

export class TextureRequestScheduler {
  private generation = 0;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly waiting: Waiter[] = [];
  private active = 0;
  private queued = 0;

  constructor(private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT) {}

  get currentGeneration() { return this.generation; }
  get queueLength() { return this.queued; }

  request<T>(request: ScheduledRequest<T>) {
    const existing = this.inFlight.get(request.key) as Promise<T> | undefined;
    if (existing) return existing;
    this.queued += 1;
    const promise = this.acquire(request.priority).then(async () => {
      try {
        if (request.generation !== this.generation) {
          throw new StaleTextureRequestError('Texture request generation is stale');
        }
        const value = await request.run();
        if (request.generation !== this.generation) {
          throw new StaleTextureRequestError('Texture request generation is stale');
        }
        return value;
      } finally {
        this.releaseSlot();
      }
    }).finally(() => {
      this.queued = Math.max(0, this.queued - 1);
      if (this.inFlight.get(request.key) === promise) this.inFlight.delete(request.key);
    });
    this.inFlight.set(request.key, promise);
    return promise;
  }

  advanceGeneration() {
    this.generation += 1;
    this.inFlight.clear();
    const waiters = this.waiting.splice(0);
    this.active = 0;
    this.queued = 0;
    // Let cancelled waiters observe the new generation and exit without work.
    waiters.forEach((waiter) => waiter.resolve());
    return this.generation;
  }

  private acquire(priority: number) {
    return new Promise<void>((resolve) => {
      this.waiting.push({ priority, resolve });
      this.waiting.sort((left, right) => right.priority - left.priority);
      this.pump();
    });
  }

  private releaseSlot() {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  private pump() {
    while (this.active < this.maxConcurrent && this.waiting.length) {
      this.active += 1;
      this.waiting.shift()!.resolve();
    }
  }
}
