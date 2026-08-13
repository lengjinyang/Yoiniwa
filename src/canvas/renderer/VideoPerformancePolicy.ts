import type { ImageItem, Viewport } from '../../types';

export const VIDEO_MAX_PLAYBACK_INTENTS = 4;
const VIDEO_FRAME_UPLOAD_BUDGET = 16 * 1024 * 1024;
export const VIDEO_POSTER_RELEASE_DELAY_MS = 1500;
export const VIDEO_DECODER_RELEASE_DELAY_MS = 2000;
export const VIDEO_SCRUB_PIXELS_PER_FRAME = 24;
export const VIDEO_SCRUB_PIXELS_PER_FRAME_MIN = 12;
export const VIDEO_SCRUB_PIXELS_PER_FRAME_MAX = 48;
export const VIDEO_SCRUB_CLICK_SLOP_PX = 4;
export const VIDEO_SURFACE_DOWNSIZE_DELAY_MS = 250;
export const VIDEO_SCRUB_IDLE_RESET_MS = 80;

const FRAME_EDGE_BUCKETS = [256, 512, 1024, 1536, 2048, 3072, 4096, 6144, 8192] as const;

export interface VideoFrameSize {
  width: number;
  height: number;
  edge: number;
  bytes: number;
}

export function videoFrameSize(
  item: ImageItem,
  viewport: Viewport,
  devicePixelRatio: number,
  maxTextureSize = 8192,
): VideoFrameSize {
  const projectedWidth = Math.max(1, Math.ceil(Math.abs(item.width * viewport.scale) * devicePixelRatio * 1.25));
  const projectedHeight = Math.max(1, Math.ceil(Math.abs(item.height * viewport.scale) * devicePixelRatio * 1.25));
  const sourceWidth = Math.max(1, item.naturalWidth);
  const sourceHeight = Math.max(1, item.naturalHeight);
  const sourceEdge = Math.max(sourceWidth, sourceHeight);
  const requiredScale = Math.max(projectedWidth / sourceWidth, projectedHeight / sourceHeight);
  const requiredEdge = Math.ceil(sourceEdge * requiredScale);
  const bucket = FRAME_EDGE_BUCKETS.find((value) => value >= requiredEdge) ?? FRAME_EDGE_BUCKETS.at(-1)!;
  const edge = Math.max(2, Math.min(sourceEdge, Math.max(2, maxTextureSize), bucket));
  const scale = Math.min(1, edge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(2, Math.round(sourceWidth * scale / 2) * 2);
  const height = Math.max(2, Math.round(sourceHeight * scale / 2) * 2);
  return { width, height, edge, bytes: width * height * 4 };
}

export function shouldResizeVideoFrame(currentEdge: number | undefined, nextEdge: number, cameraMoving: boolean) {
  if (currentEdge === undefined) return true;
  // Pan/zoom must not recreate GPU video surfaces. Growing during the gesture
  // clears the canvas, can destroy in-use textures, and can lose the WebGL context.
  if (cameraMoving) return false;
  return currentEdge !== nextEdge;
}

export function videoFrameUploadDue(
  now: number,
  lastUploadAt: number,
  playingCount: number,
  selected = false,
) {
  // Keep the video the user is actively controlling at the decoder cadence.
  // The upload budget still protects the GPU when several large frames arrive
  // together, while background videos are capped to a steady 30fps.
  if (selected || playingCount <= 1 || lastUploadAt <= 0) return true;
  // RVFC and RAF timestamps can straddle a display refresh boundary. Without
  // tolerance, alternate 30fps frames may be rejected and playback looks 15fps.
  return now - lastUploadAt >= 1000 / 30 - 1.25;
}

export function normalizeVideoFps(value: number) {
  const safe = Number.isFinite(value) && value >= 1 && value <= 240 ? value : 30;
  const standards = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
  const closest = standards.reduce((best, candidate) =>
    Math.abs(candidate - safe) < Math.abs(best - safe) ? candidate : best, standards[0]);
  return Math.abs(closest - safe) <= 0.2 ? closest : Math.round(safe * 1000) / 1000;
}

export function videoFrameScrubState(currentTime: number, duration: number, fps: number, exactFrameCount?: number) {
  const safeFps = normalizeVideoFps(fps);
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const frameCount = exactFrameCount !== undefined && Number.isFinite(exactFrameCount) && exactFrameCount > 0
    ? Math.max(1, Math.round(exactFrameCount))
    : Math.max(1, Math.round(safeDuration * safeFps));
  const maxFrame = frameCount - 1;
  const currentFrame = Math.max(0, Math.min(maxFrame, Math.floor(Math.max(0, currentTime) * safeFps + 1e-4)));
  return { fps: safeFps, frameCount, maxFrame, currentFrame };
}

export function videoFrameTime(frame: number, duration: number, fps: number, exactFrameCount?: number) {
  const state = videoFrameScrubState(0, duration, fps, exactFrameCount);
  const targetFrame = Math.max(0, Math.min(state.maxFrame, Math.round(frame)));
  // Seek into the middle of the frame's presentation interval. Exact frame
  // boundaries are vulnerable to timestamp rounding and can resolve to the
  // preceding or following frame in Chromium/WebView2.
  const midpoint = (targetFrame + 0.5) / state.fps;
  const lastSafeTime = Math.max(0, duration - 1 / (state.fps * 4));
  return Math.min(lastSafeTime, midpoint);
}

export function resolvedVideoDuration(
  itemDurationSec?: number,
  elementDuration?: number,
  assetDurationSec?: number,
) {
  if (Number.isFinite(elementDuration) && (elementDuration as number) > 0) return elementDuration as number;
  if (Number.isFinite(itemDurationSec) && (itemDurationSec as number) > 0) return itemDurationSec as number;
  if (Number.isFinite(assetDurationSec) && (assetDurationSec as number) > 0) return assetDurationSec as number;
  return 0;
}

export function clampVideoScrubPixelsPerFrame(value: unknown) {
  if (value === null || value === undefined || value === '') return VIDEO_SCRUB_PIXELS_PER_FRAME;
  const pixels = Math.round(Number(value));
  if (!Number.isFinite(pixels)) return VIDEO_SCRUB_PIXELS_PER_FRAME;
  return Math.max(
    VIDEO_SCRUB_PIXELS_PER_FRAME_MIN,
    Math.min(VIDEO_SCRUB_PIXELS_PER_FRAME_MAX, pixels),
  );
}

/** One displayed frame per this many pointer pixels, including long clips. */
export function videoScrubPixelsPerFrame(
  _spanPx?: number,
  _maxFrame?: number,
  pixelsPerFrame = VIDEO_SCRUB_PIXELS_PER_FRAME,
) {
  return clampVideoScrubPixelsPerFrame(pixelsPerFrame);
}

export function videoScrubFrameAtDelta(
  startFrame: number,
  deltaX: number,
  maxFrame: number,
  pixelsPerFrame = VIDEO_SCRUB_PIXELS_PER_FRAME,
) {
  const frameDelta = Math.trunc(deltaX / Math.max(1e-6, pixelsPerFrame));
  return Math.max(0, Math.min(Math.max(0, maxFrame), Math.round(startFrame) + frameDelta));
}

export function videoScrubStrideForVelocity(pixelsPerMs: number) {
  const speed = Math.abs(Number.isFinite(pixelsPerMs) ? pixelsPerMs : 0);
  if (speed < 0.35) return 1;
  if (speed < 0.9) return 2;
  if (speed < 1.8) return 4;
  return 8;
}

export function videoScrubTargets(lastFrame: number, desiredFrame: number, stride: number) {
  const current = Math.round(lastFrame);
  const desired = Math.round(desiredFrame);
  if (current === desired) return [];
  const direction = Math.sign(desired - current);
  if (stride > 1) {
    const distance = Math.abs(desired - current);
    if (distance < stride) return [];
    return [current + direction * Math.floor(distance / stride) * stride];
  }
  return Array.from({ length: Math.abs(desired - current) }, (_, index) => current + direction * (index + 1));
}

/** Keep live scrub on the latest playhead; sequential stepping still appends. */
export function videoLiveScrubQueue(
  queue: Array<{ frameIndex: number; sequential: boolean }>,
  target: number,
  sequential: boolean,
) {
  if (sequential) {
    if (queue.at(-1)?.frameIndex === target) return queue;
    return [...queue, { frameIndex: target, sequential: true }];
  }
  return [{ frameIndex: target, sequential: false }];
}

export function videoCloserScrubFrame(candidate: number, displayed: number, target: number) {
  return Math.abs(candidate - target) <= Math.abs(displayed - target);
}

export function videoFramePhaseUploadable(phase: string) {
  return phase === 'playing' || phase === 'paused';
}

export function videoScrubSeekTarget(inFlight: boolean, pendingTime: number | undefined) {
  return !inFlight && pendingTime !== undefined && Number.isFinite(pendingTime) ? pendingTime : undefined;
}

export function videoResponsiveSeekReady(inFlight: boolean, pendingFrame: number | undefined) {
  return !inFlight && pendingFrame !== undefined;
}

export function videoSeekAlreadyAtTime(currentTime: number, targetTime: number, fps: number) {
  const frameDuration = 1 / Math.max(1, normalizeVideoFps(fps));
  return Math.abs(currentTime - targetTime) < frameDuration * 0.2;
}

export const VIDEO_SCRUB_NEARBY_CACHE_RADIUS = 2;
export const VIDEO_SCRUB_LIVE_PREVIEW_RADIUS = 16;
export const VIDEO_SCRUB_LIVE_DECODE_CANCEL_FRAMES = 2;

export function videoShouldCancelLiveDecode(
  decodingFrame: number | undefined,
  target: number,
  threshold = VIDEO_SCRUB_LIVE_DECODE_CANCEL_FRAMES,
) {
  if (decodingFrame === undefined) return false;
  return Math.abs(target - decodingFrame) > threshold;
}

export function oldestPlaybackIntent<T extends { intentOrder: number }>(values: readonly T[]) {
  return values.reduce<T | undefined>((oldest, value) =>
    !oldest || value.intentOrder < oldest.intentOrder ? value : oldest, undefined);
}

export function videoVisibilityAction(
  intent: boolean,
  phase: string,
  visible: boolean,
  prefetched: boolean,
): 'resume' | 'suspend' | 'none' {
  if (!intent) return 'none';
  if (visible && phase === 'suspended') return 'resume';
  if (!visible && !prefetched && (phase === 'playing' || phase === 'loading')) return 'suspend';
  return 'none';
}

export interface VideoUploadCandidate {
  id: string;
  bytes: number;
  selected: boolean;
  sequence: number;
}

export function chooseVideoFrameUploads(
  candidates: readonly VideoUploadCandidate[],
  budget = VIDEO_FRAME_UPLOAD_BUDGET,
  roundRobinAfterId?: string,
) {
  const priority = candidates.filter((candidate) => candidate.selected)
    .sort((left, right) => left.sequence - right.sequence);
  const remaining = candidates.filter((candidate) => !candidate.selected);
  const previousIndex = roundRobinAfterId
    ? remaining.findIndex((candidate) => candidate.id === roundRobinAfterId)
    : -1;
  const start = previousIndex >= 0 ? (previousIndex + 1) % Math.max(1, remaining.length) : 0;
  const ordered = [
    ...priority,
    ...remaining.slice(start),
    ...remaining.slice(0, start),
  ];
  const selected: string[] = [];
  let used = 0;
  let nextRoundRobinAfterId = roundRobinAfterId;
  for (const candidate of ordered) {
    if (selected.length > 0 && used + candidate.bytes > budget) continue;
    selected.push(candidate.id);
    used += candidate.bytes;
    if (!candidate.selected) nextRoundRobinAfterId = candidate.id;
  }
  return { selected, used, nextRoundRobinAfterId };
}
