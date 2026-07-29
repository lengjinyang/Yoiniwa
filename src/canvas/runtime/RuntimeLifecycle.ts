export class RuntimeLifecycle {
  private disposers: Array<() => void> = [];
  private disposed = false;

  add(disposer: () => void) {
    if (this.disposed) { disposer(); return; }
    this.disposers.push(disposer);
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
  }
}
