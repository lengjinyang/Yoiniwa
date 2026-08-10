export interface BudgetEntry { estimatedBytes: number; pinCount: number; dispose(): void }
interface Stored<T> { value: T; used: number }

export class ByteBudgetCache<T extends BudgetEntry> {
  private readonly entries = new Map<string, Stored<T>>();
  private clock = 0;
  private byteCount = 0;
  constructor(readonly budgetBytes: number) {
    if (!Number.isFinite(budgetBytes) || budgetBytes < 0) throw new Error('Invalid byte cache budget');
  }
  get bytes() { return this.byteCount; }
  get size() { return this.entries.size; }
  get(key: string) { const entry = this.entries.get(key); if (!entry) return undefined; entry.used = ++this.clock; return entry.value; }
  peek(key: string) { return this.entries.get(key)?.value; }
  set(key: string, value: T) {
    this.delete(key);
    this.entries.set(key, { value, used: ++this.clock });
    this.byteCount += value.estimatedBytes;
    this.trim();
  }
  pin(key: string) { const value = this.get(key); if (value) value.pinCount += 1; return value; }
  unpin(key: string) { const value = this.peek(key); if (value) value.pinCount = Math.max(0, value.pinCount - 1); this.trim(); }
  delete(key: string) { const entry = this.entries.get(key); if (!entry) return false; this.entries.delete(key); this.byteCount -= entry.value.estimatedBytes; entry.value.dispose(); return true; }
  trim() {
    const candidates = [...this.entries.entries()].filter(([, entry]) => entry.value.pinCount === 0).sort((a, b) => a[1].used - b[1].used);
    for (const [key] of candidates) { if (this.byteCount <= this.budgetBytes) break; this.delete(key); }
  }
  clear() { [...this.entries.keys()].forEach((key) => this.delete(key)); }
}
