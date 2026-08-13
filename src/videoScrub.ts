import { assetResourceUrl } from './assetResourceUrl';

interface VideoFrameIndexEntry {
  frameIndex: number;
  ptsUs: number;
  durationUs: number;
  keyFrame: boolean;
}

export interface VideoScrubIndex {
  version: number;
  assetId: string;
  codec: string;
  descriptionBase64: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationUs: number;
  vfr: boolean;
  pixFmt: string;
  colorRange?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  proxyReady: boolean;
  frameAccurate: boolean;
  unsupportedReason?: string;
  frames: VideoFrameIndexEntry[];
}

export type VideoScrubBackend = 'ffmpeg-source' | 'html-video' | 'unavailable';

export interface DecodedScrubFrame {
  assetId: string;
  indexVersion?: number;
  frameIndex: number;
  width: number;
  height: number;
  bitmap: ImageBitmap;
  cacheKey: string;
}

interface CachedFrame extends DecodedScrubFrame {
  bytes: number;
  used: number;
  pinCount: number;
}

interface WorkerFrameMessage {
  type: 'frame';
  assetId: string;
  frameIndex: number;
  width: number;
  height: number;
  generation: number;
  bitmap: ImageBitmap;
}

interface WorkerCompleteMessage {
  type: 'complete';
  generation: number;
  frameIndex: number;
}

interface WorkerReadyMessage {
  type: 'ready';
  backend: VideoScrubBackend;
  reason?: string;
}

interface WorkerErrorMessage {
  type: 'error';
  generation: number;
  message: string;
}

type WorkerMessage = WorkerFrameMessage | WorkerCompleteMessage | WorkerReadyMessage | WorkerErrorMessage;

const indexPromises = new Map<string, Promise<VideoScrubIndex | undefined>>();

function scrubIndexUrl(assetId: string) {
  return assetResourceUrl(assetId, new URLSearchParams({ variant: 'scrub-index' }));
}

function cancelScrubUrl(assetId: string, generation: number) {
  return assetResourceUrl(assetId, new URLSearchParams({
    variant: 'scrub-cancel', generation: String(generation),
  }));
}

export function invalidateVideoScrubIndex(assetId: string) {
  indexPromises.delete(assetId);
}

function loadVideoScrubIndex(assetId: string) {
  let pending = indexPromises.get(assetId);
  if (!pending) {
    pending = fetch(scrubIndexUrl(assetId), { cache: 'no-store' }).then(async (response) => {
      if (response.status === 404) {
        indexPromises.delete(assetId);
        return undefined;
      }
      if (!response.ok) throw new Error(`视频帧索引加载失败 (${response.status})`);
      const index = await response.json() as VideoScrubIndex;
      if (!index.frameAccurate || index.assetId !== assetId || index.frames.length !== index.frameCount) {
        throw new Error('视频帧索引无效');
      }
      return index;
    }).catch((error) => {
      indexPromises.delete(assetId);
      throw error;
    });
    indexPromises.set(assetId, pending);
  }
  return pending;
}

export function boundedVideoFrameCacheBudget(deviceMemoryGb?: number) {
  const min = 64 * 1024 * 1024;
  const max = 192 * 1024 * 1024;
  if (!Number.isFinite(deviceMemoryGb)) return 128 * 1024 * 1024;
  return Math.max(min, Math.min(max, Math.round((deviceMemoryGb as number) * 1024 * 1024 * 1024 * 0.02)));
}

export class VideoFrameBitmapCache {
  private readonly entries = new Map<string, CachedFrame>();
  private clock = 0;
  private byteCount = 0;

  constructor(readonly budgetBytes = boundedVideoFrameCacheBudget(
    typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  )) {}

  get bytes() { return this.byteCount; }
  get size() { return this.entries.size; }

  key(assetId: string, frameIndex: number, width: number, height: number, indexVersion = 0) {
    return `${assetId}:v${indexVersion}:${frameIndex}:${width}x${height}`;
  }

  get(assetId: string, frameIndex: number, width: number, height: number, indexVersion = 0) {
    const entry = this.entries.get(this.key(assetId, frameIndex, width, height, indexVersion));
    if (entry) entry.used = ++this.clock;
    return entry;
  }

  nearest(assetId: string, frameIndex: number, width: number, height: number, indexVersion = 0, radius = 2) {
    const exact = this.get(assetId, frameIndex, width, height, indexVersion);
    if (exact) return exact;
    for (let distance = 1; distance <= radius; distance += 1) {
      const before = this.get(assetId, frameIndex - distance, width, height, indexVersion);
      if (before) return before;
      const after = this.get(assetId, frameIndex + distance, width, height, indexVersion);
      if (after) return after;
    }
  }

  set(frame: Omit<DecodedScrubFrame, 'cacheKey'>) {
    const cacheKey = this.key(frame.assetId, frame.frameIndex, frame.width, frame.height, frame.indexVersion);
    this.delete(cacheKey);
    const entry: CachedFrame = {
      ...frame, cacheKey, bytes: frame.width * frame.height * 4, used: ++this.clock, pinCount: 0,
    };
    this.entries.set(cacheKey, entry);
    this.byteCount += entry.bytes;
    this.trim();
    return entry;
  }

  pin(cacheKey?: string) {
    if (!cacheKey) return;
    const entry = this.entries.get(cacheKey);
    if (entry) { entry.pinCount += 1; entry.used = ++this.clock; }
  }

  unpin(cacheKey?: string) {
    if (!cacheKey) return;
    const entry = this.entries.get(cacheKey);
    if (entry) entry.pinCount = Math.max(0, entry.pinCount - 1);
    this.trim();
  }

  clearAsset(assetId: string) {
    [...this.entries.entries()].forEach(([key, entry]) => {
      if (entry.assetId === assetId) this.delete(key);
    });
  }

  clear() { [...this.entries.keys()].forEach((key) => this.delete(key)); }

  private trim() {
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => entry.pinCount === 0)
      .sort((left, right) => left[1].used - right[1].used);
    for (const [key] of candidates) {
      if (this.byteCount <= this.budgetBytes) break;
      // One source-sized 8K frame can exceed the adaptive budget. Keep the
      // newest candidate alive long enough for the renderer to pin/upload it.
      if (this.entries.size <= 1) break;
      this.delete(key);
    }
  }

  private delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.byteCount -= entry.bytes;
    entry.bitmap.close();
  }
}

interface PendingDecode {
  frameIndex: number;
  resolve(frame: DecodedScrubFrame): void;
  reject(error: Error): void;
}

export class FfmpegFrameProvider {
  readonly cache = new VideoFrameBitmapCache();
  private worker?: Worker;
  private assetId?: string;
  private index?: VideoScrubIndex;
  private generation = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  private readonly pending = new Map<number, PendingDecode>();
  private backend: VideoScrubBackend = 'unavailable';
  private backendReason?: string;
  private readyResolve?: () => void;

  get activeBackend() { return this.backend; }
  get reason() { return this.backendReason; }
  get activeIndex() { return this.index; }

  async prepare(assetId: string, durationSec = 0, fps = 30, frameCountHint?: number) {
    if (this.assetId === assetId && this.worker) return this.index;
    this.releaseWorker();
    this.assetId = assetId;
    try {
      this.index = await loadVideoScrubIndex(assetId);
    } catch {
      this.index = undefined;
    }
    this.worker = new Worker(new URL('./workers/videoScrub.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.onWorkerMessage(event.data);
    this.worker.onerror = (event) => {
      this.backend = 'html-video';
      this.backendReason = event.message || '逐帧解码 Worker 启动失败';
      const generation = ++this.generation;
      this.rejectPending(new Error(this.backendReason));
      if (this.assetId) void fetch(cancelScrubUrl(this.assetId, generation), { cache: 'no-store' }).catch(() => {});
      this.readyResolve?.();
      this.readyResolve = undefined;
    };
    const ready = new Promise<void>((resolve) => { this.readyResolve = resolve; });
    const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
    const frameCount = this.index?.frameCount ?? frameCountHint
      ?? Math.max(1, Math.round(Math.max(0, durationSec) * safeFps));
    this.worker.postMessage({
      type: 'init', index: this.index, assetId,
      durationUs: this.index?.durationUs ?? Math.round(Math.max(0, durationSec) * 1_000_000),
      frameCount,
    });
    let timeout = 0;
    try {
      await Promise.race([
        ready,
        new Promise<void>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('FFmpeg Scrub Worker 启动超时')), 3000);
        }),
      ]);
    } catch (error) {
      this.backend = 'html-video';
      this.backendReason = error instanceof Error ? error.message : String(error);
      this.releaseWorker();
      throw error;
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }
    return this.index;
  }

  requestFrame(frameIndex: number, width: number, height: number, cancelPrevious: boolean, cacheNearby = false) {
    const assetId = this.assetId;
    const index = this.index;
    if (!assetId || this.backend !== 'ffmpeg-source' || !this.worker) {
      return Promise.reject(new Error(this.backendReason || 'FFmpeg 原片逐帧解码不可用'));
    }
    const frameCount = index?.frameCount ?? Number.MAX_SAFE_INTEGER;
    const safeFrame = Math.max(0, Math.min(frameCount - 1, Math.round(frameIndex)));
    const cacheVersion = index?.version ?? 0;
    const cached = this.cache.get(assetId, safeFrame, width, height, cacheVersion);
    if (cached) return Promise.resolve(cached as DecodedScrubFrame);
    if (cancelPrevious) this.cancelPending();
    const generation = ++this.generation;
    const promise = new Promise<DecodedScrubFrame>((resolve, reject) => {
      this.pending.set(generation, { frameIndex: safeFrame, resolve, reject });
    });
    this.worker.postMessage({
      type: 'decode', generation, frameIndex: safeFrame, width, height, prefetch: cacheNearby,
    });
    return promise;
  }

  cancelPending() {
    const generation = ++this.generation;
    this.rejectPending(new Error('stale'));
    this.worker?.postMessage({ type: 'cancel', generation });
    if (this.assetId) void fetch(cancelScrubUrl(this.assetId, generation), { cache: 'no-store' }).catch(() => {});
  }

  async prefetchNearby(frameIndex: number, width: number, height: number, radius = 3) {
    const index = this.index;
    const assetId = this.assetId;
    if (!assetId || this.backend !== 'ffmpeg-source') return;
    const maxFrame = (index?.frameCount ?? Math.max(1, frameIndex + radius + 1)) - 1;
    const targets: number[] = [];
    for (let distance = 1; distance <= radius; distance += 1) {
      if (frameIndex - distance >= 0) targets.push(frameIndex - distance);
      if (frameIndex + distance <= maxFrame) targets.push(frameIndex + distance);
    }
    for (const target of targets) {
      if (this.cache.get(assetId, target, width, height, index?.version ?? 0)) continue;
      try {
        await this.requestFrame(target, width, height, false, true);
      } catch {
        return;
      }
    }
  }

  release() {
    this.releaseWorker();
    this.cache.clear();
    this.assetId = undefined;
    this.index = undefined;
    this.backend = 'unavailable';
    this.backendReason = undefined;
  }

  private onWorkerMessage(message: WorkerMessage) {
    if (message.type === 'ready') {
      this.backend = message.backend;
      this.backendReason = message.reason;
      this.readyResolve?.();
      this.readyResolve = undefined;
      return;
    }
    if (message.type === 'frame') {
      if (message.assetId !== this.assetId) { message.bitmap.close(); return; }
      const frame = this.cache.set({
        assetId: message.assetId, frameIndex: message.frameIndex,
        indexVersion: this.index?.version ?? 0,
        width: message.width, height: message.height, bitmap: message.bitmap,
      });
      const pending = this.pending.get(message.generation);
      if (pending?.frameIndex === frame.frameIndex) {
        this.pending.delete(message.generation);
        pending.resolve(frame);
      }
      return;
    }
    if (message.type === 'error') {
      const pending = this.pending.get(message.generation);
      if (pending) { this.pending.delete(message.generation); pending.reject(new Error(message.message)); }
      return;
    }
    const pending = this.pending.get(message.generation);
    if (!pending) return;
    this.pending.delete(message.generation);
    pending.reject(new Error(`逐帧解码未输出目标帧 ${message.frameIndex}`));
  }

  private rejectPending(error: Error) {
    this.pending.forEach((pending) => pending.reject(error));
    this.pending.clear();
  }

  private releaseWorker() {
    this.rejectPending(new Error('stale'));
    const generation = ++this.generation;
    if (this.assetId) void fetch(cancelScrubUrl(this.assetId, generation), { cache: 'no-store' }).catch(() => {});
    this.worker?.postMessage({ type: 'close' });
    this.worker?.terminate();
    this.worker = undefined;
    this.readyResolve?.();
    this.readyResolve = undefined;
  }
}

export function videoFrameAtTime(index: VideoScrubIndex, seconds: number) {
  const targetUs = Math.max(0, seconds * 1_000_000);
  let low = 0;
  let high = index.frames.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (index.frames[middle].ptsUs <= targetUs) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, Math.min(index.frameCount - 1, high));
}

export function videoFrameSeekTime(index: VideoScrubIndex, frameIndex: number) {
  const frame = index.frames[Math.max(0, Math.min(index.frameCount - 1, Math.round(frameIndex)))];
  return (frame.ptsUs + Math.max(1, frame.durationUs) * 0.5) / 1_000_000;
}
