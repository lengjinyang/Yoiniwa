import { useEffect, useState } from 'react';
import { performanceMonitor, type PerformanceSnapshot } from './runtime/performanceMonitor';

const formatBytes = (bytes?: number) => bytes === undefined ? 'n/a'
  : bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const formatMs = (value: number) => `${value.toFixed(value >= 10 ? 1 : 2)} ms`;

export function PerformancePanel() {
  const [visible, setVisible] = useState(performanceMonitor.enabled);
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot>(() => performanceMonitor.snapshot());
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.key !== 'F10') return;
      event.preventDefault();
      setVisible((current) => {
        performanceMonitor.setEnabled(!current);
        return !current;
      });
    };
    window.addEventListener('keydown', toggle);
    return () => window.removeEventListener('keydown', toggle);
  }, []);
  useEffect(() => {
    if (!visible) return undefined;
    performanceMonitor.setEnabled(true);
    performanceMonitor.start();
    const update = () => {
      setSnapshot(performanceMonitor.snapshot());
      void window.refCanvas?.getImagePerformanceStats().then((stats) => performanceMonitor.setPipelineStats(stats)).catch(() => undefined);
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [visible]);
  if (!visible) return null;
  const rows: Array<[string, string]> = [
    ['FPS', snapshot.fps.toFixed(1)],
    ['CPU / frame', formatMs(snapshot.cpuFrameMs)],
    ['backend', snapshot.backend],
    ['draw calls / frame', String(snapshot.drawCalls)],
    ['bindTexture / frame', String(snapshot.bindTextureCalls)],
    ['bufferData / subData', `${snapshot.bufferDataCalls} / ${snapshot.bufferSubDataCalls}`],
    ['texImage2D / sub', `${snapshot.texImage2DCalls} / ${snapshot.texSubImage2DCalls}`],
    ['texture upload total', formatMs(snapshot.textureUploadMs)],
    ['visible / total', `${snapshot.visibleImages} / ${snapshot.totalImages}`],
    ['GPU textures', String(snapshot.gpuTextures)],
    ['GPU estimate', formatBytes(snapshot.gpuBytes)],
    ['CPU image cache', formatBytes(snapshot.cpuImageBytes)],
    ['preload images', String(snapshot.preloadImages)],
    ['decode / upload queue', `${snapshot.decodeQueueLength} / ${snapshot.uploadQueueLength}`],
    ['frame upload', formatBytes(snapshot.frameUploadBytes)],
    ['cache hit rate', `${(snapshot.cacheHitRate * 100).toFixed(1)}%`],
    ['current Mip', snapshot.currentMip],
    ['video intent / decoder', `${snapshot.videoPlaybackIntents} / ${snapshot.activeVideoDecoders}`],
    ['video suspended / posters', `${snapshot.suspendedVideos} / ${snapshot.videoPosterTextures}`],
    ['video uploads / dropped', `${snapshot.videoFrameUploads} / ${snapshot.droppedVideoFrames}`],
    ['video upload / drop fps', `${snapshot.videoUploadFps} / ${snapshot.droppedVideoFps}`],
    ['video upload bytes', formatBytes(snapshot.videoFrameUploadBytes)],
    ['proxy active / queued', `${snapshot.proxyActive} / ${snapshot.proxyQueued}`],
    ['FFmpeg active / requests', `${snapshot.ffmpegActive} / ${snapshot.ffmpegDecodeRequests}`],
    ['FFmpeg decode avg', formatMs(snapshot.ffmpegDecodeMs)],
    ['JS Heap', formatBytes(snapshot.jsHeapBytes)],
    ['pointermove / s', snapshot.pointerMovesPerSecond.toFixed(0)],
    ['React renders / s', snapshot.reactRendersPerSecond.toFixed(1)],
    ['spatial query avg', formatMs(snapshot.spatialQueryMs)],
    ['image decode avg', formatMs(snapshot.imageDecodeMs)],
    ['color sample avg', formatMs(snapshot.colorSampleMs)],
    ['thumbnail avg', `${formatMs(snapshot.thumbnailMs)} (${snapshot.thumbnailCount}, fail ${snapshot.thumbnailFailures})`],
  ];
  return <aside className="performance-panel no-drag" data-testid="performance-panel">
    <header title="按 F10 隐藏">Yoiniwa Performance · F10</header>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </aside>;
}
