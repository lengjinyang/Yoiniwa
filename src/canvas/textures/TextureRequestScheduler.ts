interface ScheduledRequest<T> {
  key: string;
  generation: number;
  priority: number;
  run(): Promise<T>;
}

export class StaleTextureRequestError extends Error {}

export class TextureRequestScheduler {
  private generation = 0;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private queued = 0;

  get currentGeneration() { return this.generation; }
  get queueLength() { return this.queued; }

  request<T>(request: ScheduledRequest<T>) {
    const existing = this.inFlight.get(request.key) as Promise<T> | undefined;
    if (existing) return existing;
    this.queued += 1;
    const promise = Promise.resolve().then(request.run).then((value) => {
      if (request.generation !== this.generation) throw new StaleTextureRequestError('Texture request generation is stale');
      return value;
    }).finally(() => {
      this.queued -= 1;
      if (this.inFlight.get(request.key) === promise) this.inFlight.delete(request.key);
    });
    this.inFlight.set(request.key, promise);
    return promise;
  }

  advanceGeneration() { this.generation += 1; this.inFlight.clear(); return this.generation; }
}
