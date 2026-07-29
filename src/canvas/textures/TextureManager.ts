import { Texture } from 'pixi.js';
import { imageRequestKey } from '../../shared/imagePipelineConfig';
import { CpuImageCache, createDecodedImageEntry, type DecodedImageEntry } from './CpuImageCache';
import { GpuTextureCache, type GpuTextureEntry } from './GpuTextureCache';
import { GpuUploadQueue } from './GpuUploadQueue';
import { StaleTextureRequestError, TextureRequestScheduler } from './TextureRequestScheduler';

interface TextureUploadRenderer { texture: { initSource(source: Texture['source']): void } }
interface TextureRequest { assetId: string; mip: number; tileX?: number; tileY?: number; url: string; priority: number }

export class TextureManager {
  readonly requests = new TextureRequestScheduler();
  readonly uploads = new GpuUploadQueue();
  readonly cpu: CpuImageCache;
  readonly gpu: GpuTextureCache;
  private readonly inFlight = new Map<string, Promise<GpuTextureEntry>>();
  private destroyed = false;
  cacheHits = 0;
  cacheMisses = 0;
  lastError = '';
  private peaks = { cpuBytes: 0, gpuBytes: 0, decodeQueueLength: 0, uploadQueueLength: 0, frameUploadBytes: 0 };

  constructor(
    private readonly renderer: TextureUploadRenderer,
    private readonly requestFrame: () => void,
    options: { deviceMemoryGb?: number; gpuBudgetBytes?: number } = {},
  ) {
    this.cpu = new CpuImageCache(options.deviceMemoryGb);
    this.gpu = new GpuTextureCache(options.gpuBudgetBytes);
  }

  request(request: TextureRequest): Promise<GpuTextureEntry> {
    const key = imageRequestKey(request.assetId, request.mip, request.tileX, request.tileY);
    const cached = this.gpu.pin(key);
    if (cached) { this.cacheHits += 1; return Promise.resolve(cached); }
    this.cacheMisses += 1;
    let pending = this.inFlight.get(key);
    if (!pending) {
      const generation = this.requests.currentGeneration;
      pending = this.requests.request({
        key, generation, priority: request.priority,
        run: () => this.decodeAndUpload(key, request, generation),
      }).catch((error: unknown) => { this.lastError = error instanceof Error ? error.message : String(error); throw error; });
      this.inFlight.set(key, pending);
      void pending.finally(() => { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); }).catch(() => undefined);
    }
    return pending.then(() => {
      const acquired = this.gpu.pin(key);
      if (!acquired) throw new StaleTextureRequestError('Uploaded texture was evicted before acquisition');
      return acquired;
    });
  }

  release(key: string) { this.gpu.unpin(key); }

  processFrame() {
    const result = this.uploads.processFrame();
    if (this.uploads.length) this.requestFrame();
    return result;
  }

  advanceGeneration() {
    this.requests.advanceGeneration();
    this.uploads.clear(new StaleTextureRequestError('Canvas texture generation changed'));
    this.inFlight.clear();
    this.gpu.clear();
    this.cpu.clear();
    this.peaks = { cpuBytes: 0, gpuBytes: 0, decodeQueueLength: 0, uploadQueueLength: 0, frameUploadBytes: 0 };
  }

  stats() {
    const current = {
      cpuBytes: this.cpu.bytes, gpuBytes: this.gpu.bytes, gpuTextures: this.gpu.size,
      decodeQueueLength: this.requests.queueLength, uploadQueueLength: this.uploads.length,
      uploadedBytesThisFrame: this.uploads.lastFrameBytes, cacheHits: this.cacheHits, cacheMisses: this.cacheMisses,
      lastError: this.lastError,
    };
    this.peaks = {
      cpuBytes: Math.max(this.peaks.cpuBytes, current.cpuBytes),
      gpuBytes: Math.max(this.peaks.gpuBytes, current.gpuBytes),
      decodeQueueLength: Math.max(this.peaks.decodeQueueLength, current.decodeQueueLength),
      uploadQueueLength: Math.max(this.peaks.uploadQueueLength, current.uploadQueueLength),
      frameUploadBytes: Math.max(this.peaks.frameUploadBytes, current.uploadedBytesThisFrame),
    };
    return { ...current, peakCpuBytes: this.peaks.cpuBytes, peakGpuBytes: this.peaks.gpuBytes,
      peakDecodeQueueLength: this.peaks.decodeQueueLength, peakUploadQueueLength: this.peaks.uploadQueueLength,
      peakFrameUploadBytes: this.peaks.frameUploadBytes };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.advanceGeneration();
    this.gpu.clear();
  }

  private async decodeAndUpload(key: string, request: TextureRequest, generation: number) {
    if (this.destroyed) throw new StaleTextureRequestError('Texture manager is destroyed');
    let decoded = this.cpu.pin(key);
    if (!decoded) {
      const response = await fetch(request.url);
      if (!response.ok) throw new Error(`Mip request failed (${response.status}): ${request.url}`);
      const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default' });
      decoded = createDecodedImageEntry(bitmap);
      decoded.pinCount = 1;
      this.cpu.set(key, decoded);
    }
    try {
      const upload = this.uploads.request({
        key, estimatedBytes: decoded.estimatedBytes, priority: request.priority,
        upload: () => this.uploadDecoded(key, decoded as DecodedImageEntry, generation),
      });
      this.requestFrame();
      return await upload;
    } finally {
      // The decoded bitmap remains in the byte-budgeted CPU LRU after upload.
      // Only its temporary upload pin is released here.
      this.cpu.unpin(key);
    }
  }

  private async uploadDecoded(key: string, decoded: DecodedImageEntry, generation: number) {
    if (generation !== this.requests.currentGeneration) throw new StaleTextureRequestError('Upload generation is stale');
    const texture = Texture.from(decoded.bitmap);
    texture.source.style.scaleMode = 'linear';
    this.renderer.texture.initSource(texture.source);
    if (generation !== this.requests.currentGeneration) {
      texture.destroy(true);
      throw new StaleTextureRequestError('Completed upload generation is stale');
    }
    const entry: GpuTextureEntry = {
      key, texture, width: decoded.width, height: decoded.height,
      estimatedBytes: decoded.estimatedBytes, pinCount: 0,
      dispose: () => texture.destroy(true),
    };
    this.gpu.set(key, entry);
    return entry;
  }
}
