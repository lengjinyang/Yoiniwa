/** Generation-scoped single-flight registrations for the current Worker process. */
export class WorkerAssetRegistrations {
  private readonly registrations = new Map<string, Promise<unknown>>();

  get size() { return this.registrations.size; }

  getOrCreate(generation: number, assetId: string, register: () => Promise<unknown>) {
    const key = `${generation}:${assetId}`;
    const existing = this.registrations.get(key);
    if (existing) return existing;
    const registration = register();
    this.registrations.set(key, registration);
    registration.catch(() => {
      if (this.registrations.get(key) === registration) this.registrations.delete(key);
    });
    return registration;
  }

  deleteAsset(assetId: string) {
    for (const key of this.registrations.keys()) if (key.endsWith(`:${assetId}`)) this.registrations.delete(key);
  }

  clear() { this.registrations.clear(); }
}
