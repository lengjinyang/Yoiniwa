import type { ImagePipelinePerformanceStats } from '../types';
import type { VideoRuntimeStats } from '../canvas/renderer/VideoRenderer';

interface ImageRenderStats {
  drawCalls: number; instances: number; gpuBytes: number; textureUploads: number; textureCount: number;
  bindTextureCalls: number; bufferDataCalls: number; bufferSubDataCalls: number;
  texImage2DCalls: number; texSubImage2DCalls: number; textureUploadMs: number;
  renderedViewportX: number; renderedViewportY: number; renderedViewportScale: number;
}

export interface PerformanceSnapshot {
  fps: number;
  cpuFrameMs: number;
  backend: string;
  drawCalls: number;
  bindTextureCalls: number;
  bufferDataCalls: number;
  bufferSubDataCalls: number;
  texImage2DCalls: number;
  texSubImage2DCalls: number;
  textureUploadMs: number;
  visibleImages: number;
  totalImages: number;
  gpuTextures: number;
  gpuBytes: number;
  jsHeapBytes?: number;
  pointerMovesPerSecond: number;
  reactRendersPerSecond: number;
  spatialQueryMs: number;
  imageDecodeMs: number;
  colorSampleMs: number;
  thumbnailMs: number;
  thumbnailCount: number;
  thumbnailFailures: number;
  cpuImageBytes: number;
  preloadImages: number;
  decodeQueueLength: number;
  uploadQueueLength: number;
  frameUploadBytes: number;
  cacheHitRate: number;
  currentMip: string;
  videoPlaybackIntents: number;
  activeVideoDecoders: number;
  suspendedVideos: number;
  videoPosterTextures: number;
  videoFrameUploads: number;
  videoFrameUploadBytes: number;
  droppedVideoFrames: number;
  videoUploadFps: number;
  droppedVideoFps: number;
  proxyActive: number;
  proxyQueued: number;
  ffmpegActive: number;
  ffmpegDecodeRequests: number;
  ffmpegDecodeMs: number;
}

const initiallyEnabled = typeof window !== 'undefined'
  && (new URLSearchParams(window.location.search).get('perf') === '1'
    || new URLSearchParams(window.location.search).has('perf-bench'));

const MAX_SAMPLES = 240;
const trim = (values: number[]) => {
  if (values.length > MAX_SAMPLES) values.splice(0, values.length - MAX_SAMPLES);
};
const mean = (values: readonly number[]) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length : 0;

class PerformanceMonitor {
  private active = initiallyEnabled;
  private rafId?: number;
  private lastRaf = 0;
  private frameIntervals: number[] = [];
  private cpuFrames: number[] = [];
  private spatialQueries: number[] = [];
  private imageDecodes: number[] = [];
  private colorSamples: number[] = [];
  private pointerMoves = 0;
  private reactRenders = 0;
  private lastRateAt = performance.now();
  private pointerRate = 0;
  private reactRate = 0;
  private backend = 'unknown';
  private visibleImages = 0;
  private totalImages = 0;
  private runtimeStats = {
    cpuImageBytes: 0, preloadImages: 0, decodeQueueLength: 0, uploadQueueLength: 0,
    frameUploadBytes: 0, cacheHitRate: 0, currentMip: '-',
  };
  private videoStats: VideoRuntimeStats = {
    playbackIntents: 0, activeDecoders: 0, suspendedVideos: 0, posterTextures: 0,
    frameUploads: 0, frameUploadBytes: 0, droppedFrames: 0, uploadFps: 0, droppedFps: 0,
  };
  private rendererStats: ImageRenderStats = {
    drawCalls: 0, instances: 0, gpuBytes: 0, textureUploads: 0, textureCount: 0,
    bindTextureCalls: 0, bufferDataCalls: 0, bufferSubDataCalls: 0,
    texImage2DCalls: 0, texSubImage2DCalls: 0, textureUploadMs: 0,
    renderedViewportX: 0, renderedViewportY: 0, renderedViewportScale: 0,
  };
  private pipelineStats: ImagePipelinePerformanceStats = {
    metadataCount: 0, metadataMs: 0, thumbnailCount: 0, thumbnailMs: 0, thumbnailFailures: 0,
  };

  get enabled() { return this.active; }

  setEnabled(enabled: boolean) {
    this.active = enabled;
    if (enabled) this.start();
    else if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
      this.lastRaf = 0;
    }
  }

  start() {
    if (!this.active || this.rafId !== undefined) return;
    const tick = (now: number) => {
      if (this.lastRaf > 0) {
        this.frameIntervals.push(now - this.lastRaf);
        trim(this.frameIntervals);
      }
      this.lastRaf = now;
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  markPointerMove() { if (this.active) this.pointerMoves += 1; }
  markReactRender() { if (this.active) this.reactRenders += 1; }
  recordRendererFrame(durationMs: number, stats: ImageRenderStats, backend: string) {
    if (!this.active) return;
    this.cpuFrames.push(durationMs); trim(this.cpuFrames);
    this.rendererStats = stats;
    this.backend = backend;
  }
  recordCanvasRuntimeFrame(durationMs: number, backend: string) {
    if (!this.active) return;
    this.cpuFrames.push(durationMs); trim(this.cpuFrames);
    this.backend = backend;
  }
  setCanvasGpuStats(textureCount: number, gpuBytes: number) {
    if (!this.active) return;
    this.rendererStats = { ...this.rendererStats, textureCount, gpuBytes };
  }
  recordSpatialQuery(durationMs: number) {
    if (!this.active) return;
    this.spatialQueries.push(durationMs); trim(this.spatialQueries);
  }
  recordImageDecode(durationMs: number) {
    if (!this.active) return;
    this.imageDecodes.push(durationMs); trim(this.imageDecodes);
  }
  recordColorSample(durationMs: number) {
    if (!this.active) return;
    this.colorSamples.push(durationMs); trim(this.colorSamples);
  }
  setSceneCounts(visibleImages: number, totalImages: number, backend: string) {
    if (!this.active) return;
    this.visibleImages = visibleImages;
    this.totalImages = totalImages;
    this.backend = backend;
  }
  setPipelineStats(stats: ImagePipelinePerformanceStats) {
    if (this.active) this.pipelineStats = stats;
  }
  setImageRuntimeStats(stats: Partial<typeof this.runtimeStats>) {
    if (this.active) this.runtimeStats = { ...this.runtimeStats, ...stats };
  }
  setVideoRuntimeStats(stats: VideoRuntimeStats) {
    if (this.active) this.videoStats = stats;
  }

  snapshot(): PerformanceSnapshot {
    const now = performance.now();
    const elapsed = now - this.lastRateAt;
    if (elapsed >= 500) {
      const scale = 1000 / elapsed;
      this.pointerRate = this.pointerMoves * scale;
      this.reactRate = this.reactRenders * scale;
      this.pointerMoves = 0;
      this.reactRenders = 0;
      this.lastRateAt = now;
    }
    const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const averageFrameInterval = mean(this.frameIntervals);
    return {
      fps: averageFrameInterval > 0 ? Math.min(999, 1000 / averageFrameInterval) : 0,
      cpuFrameMs: mean(this.cpuFrames),
      backend: this.backend,
      drawCalls: this.rendererStats.drawCalls,
      bindTextureCalls: this.rendererStats.bindTextureCalls,
      bufferDataCalls: this.rendererStats.bufferDataCalls,
      bufferSubDataCalls: this.rendererStats.bufferSubDataCalls,
      texImage2DCalls: this.rendererStats.texImage2DCalls,
      texSubImage2DCalls: this.rendererStats.texSubImage2DCalls,
      textureUploadMs: this.rendererStats.textureUploadMs,
      visibleImages: this.visibleImages,
      totalImages: this.totalImages,
      gpuTextures: this.rendererStats.textureCount,
      gpuBytes: this.rendererStats.gpuBytes,
      jsHeapBytes: memory.memory?.usedJSHeapSize,
      pointerMovesPerSecond: this.pointerRate,
      reactRendersPerSecond: this.reactRate,
      spatialQueryMs: mean(this.spatialQueries),
      imageDecodeMs: mean(this.imageDecodes),
      colorSampleMs: mean(this.colorSamples),
      thumbnailMs: this.pipelineStats.thumbnailCount ? this.pipelineStats.thumbnailMs / this.pipelineStats.thumbnailCount : 0,
      thumbnailCount: this.pipelineStats.thumbnailCount,
      thumbnailFailures: this.pipelineStats.thumbnailFailures,
      videoPlaybackIntents: this.videoStats.playbackIntents,
      activeVideoDecoders: this.videoStats.activeDecoders,
      suspendedVideos: this.videoStats.suspendedVideos,
      videoPosterTextures: this.videoStats.posterTextures,
      videoFrameUploads: this.videoStats.frameUploads,
      videoFrameUploadBytes: this.videoStats.frameUploadBytes,
      droppedVideoFrames: this.videoStats.droppedFrames,
      videoUploadFps: this.videoStats.uploadFps,
      droppedVideoFps: this.videoStats.droppedFps,
      proxyActive: this.pipelineStats.proxyActive ?? 0,
      proxyQueued: this.pipelineStats.proxyQueued ?? 0,
      ffmpegActive: this.pipelineStats.videoDecodeActive ?? 0,
      ffmpegDecodeRequests: this.pipelineStats.videoDecodeRequests ?? 0,
      ffmpegDecodeMs: this.pipelineStats.videoDecodeMs ?? 0,
      ...this.runtimeStats,
    };
  }
}

export const performanceMonitor = new PerformanceMonitor();

if (typeof window !== 'undefined') {
  (window as typeof window & { __refCanvasPerformanceSnapshot?: () => PerformanceSnapshot })
    .__refCanvasPerformanceSnapshot = () => performanceMonitor.snapshot();
}
