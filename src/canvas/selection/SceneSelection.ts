export class SceneSelection {
  private ids = new Set<string>();
  values() { return [...this.ids]; }
  has(id: string) { return this.ids.has(id); }
  replace(ids: Iterable<string>) { this.ids = new Set(ids); }
  clear() { this.ids.clear(); }
  toggle(id: string) { if (this.ids.has(id)) this.ids.delete(id); else this.ids.add(id); }
  add(id: string) { this.ids.add(id); }
}
