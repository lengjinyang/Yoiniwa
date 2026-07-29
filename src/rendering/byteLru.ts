export interface ByteLruValue {
  estimatedBytes: number;
  pinCount?: number;
  dispose?(): void;
}

interface Entry<T> {
  value: T;
  lastUsed: number;
}

/** Byte-based LRU. Pinned entries may temporarily take the cache over budget. */
export class ByteLru<T extends ByteLruValue> {
  private readonly entries = new Map<string, Entry<T>>();
  private clock = 0;
  private usedBytes = 0;

  constructor(readonly budgetBytes: number) {
    if (!Number.isFinite(budgetBytes) || budgetBytes < 0) throw new Error('LRU 字节预算无效');
  }

  get bytes() { return this.usedBytes; }
  get size() { return this.entries.size; }

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastUsed = ++this.clock;
    return entry.value;
  }

  peek(key: string) { return this.entries.get(key)?.value; }

  set(key: string, value: T) {
    const previous = this.entries.get(key);
    if (previous) {
      this.usedBytes -= previous.value.estimatedBytes;
      if (previous.value !== value) previous.value.dispose?.();
    }
    this.entries.set(key, { value, lastUsed: ++this.clock });
    this.usedBytes += value.estimatedBytes;
    this.trim();
  }

  pin(key: string) {
    const value = this.get(key);
    if (value) value.pinCount = (value.pinCount ?? 0) + 1;
    return value;
  }

  unpin(key: string) {
    const value = this.peek(key);
    if (value) value.pinCount = Math.max(0, (value.pinCount ?? 0) - 1);
    this.trim();
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.usedBytes -= entry.value.estimatedBytes;
    entry.value.dispose?.();
    return true;
  }

  trim() {
    if (this.usedBytes <= this.budgetBytes) return 0;
    let removed = 0;
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => !(entry.value.pinCount ?? 0))
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [key] of candidates) {
      if (this.usedBytes <= this.budgetBytes) break;
      if (this.delete(key)) removed += 1;
    }
    return removed;
  }

  clear() {
    for (const entry of this.entries.values()) entry.value.dispose?.();
    this.entries.clear();
    this.usedBytes = 0;
  }
}
