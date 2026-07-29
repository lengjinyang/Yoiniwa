export class RenderObjectRegistry<T extends { destroy(): void }> {
  private readonly values = new Map<string, T>();

  get(id: string) { return this.values.get(id); }
  set(id: string, value: T) {
    this.values.get(id)?.destroy();
    this.values.set(id, value);
  }
  delete(id: string) {
    const value = this.values.get(id);
    if (!value) return;
    this.values.delete(id);
    value.destroy();
  }
  retain(ids: ReadonlySet<string>) {
    [...this.values.keys()].forEach((id) => { if (!ids.has(id)) this.delete(id); });
  }
  forEach(callback: (value: T, id: string) => void) { this.values.forEach(callback); }
  destroy() { this.retain(new Set()); }
  get size() { return this.values.size; }
}
