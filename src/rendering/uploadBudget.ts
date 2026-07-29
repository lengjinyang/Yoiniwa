import {
  GPU_UPLOAD_MAX_BYTES_PER_FRAME, GPU_UPLOAD_MAX_ITEMS_PER_FRAME, GPU_UPLOAD_MAX_MS_PER_FRAME,
} from '../shared/imagePipelineConfig';

export interface UploadCandidate {
  key: string;
  estimatedBytes: number;
  priority: number;
  upload(): void;
}

export class UploadBudgetQueue {
  private readonly requests = new Map<string, UploadCandidate>();

  get length() { return this.requests.size; }
  has(key: string) { return this.requests.has(key); }

  request(candidate: UploadCandidate) {
    const current = this.requests.get(candidate.key);
    if (!current || candidate.priority > current.priority) this.requests.set(candidate.key, candidate);
  }

  cancel(predicate: (key: string) => boolean) {
    let count = 0;
    for (const key of this.requests.keys()) if (predicate(key)) {
      this.requests.delete(key);
      count += 1;
    }
    return count;
  }

  flush(now: () => number = performance.now.bind(performance), limits = {
    items: GPU_UPLOAD_MAX_ITEMS_PER_FRAME,
    bytes: GPU_UPLOAD_MAX_BYTES_PER_FRAME,
    ms: GPU_UPLOAD_MAX_MS_PER_FRAME,
  }) {
    const started = now();
    let count = 0;
    let bytes = 0;
    const uploaded: string[] = [];
    const ordered = [...this.requests.values()].sort((left, right) => right.priority - left.priority);
    for (const candidate of ordered) {
      if (count >= limits.items || (count > 0 && bytes + candidate.estimatedBytes > limits.bytes)
        || (count > 0 && now() - started >= limits.ms)) break;
      this.requests.delete(candidate.key);
      candidate.upload();
      uploaded.push(candidate.key);
      count += 1;
      bytes += candidate.estimatedBytes;
    }
    return { uploaded, count, bytes, elapsedMs: now() - started, remaining: this.requests.size };
  }
}
