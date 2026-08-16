import { assetResourceUrl } from './assetResourceUrl';
import type { VideoFrameTimingIndex, VideoPreparationResult } from '../types';

type PlaybackUrlKind = 'original' | 'proxy';

const playbackUrlCache = new Map<string, { url: string; fps: number; frameCount?: number; kind: PlaybackUrlKind }>();
const fpsHints = new Map<string, number>();
const frameCountHints = new Map<string, number>();
const frameTimingIndexes = new Map<string, VideoFrameTimingIndex>();
const pendingProxy = new Set<string>();
const rejectedOriginals = new Set<string>();

export interface VideoPlaybackLookup {
  ensurePlayback(assetId: string): Promise<VideoPreparationResult>;
}

export function videoPlaybackLookupFromApi(api: Window['refCanvas'] | undefined): VideoPlaybackLookup | undefined {
  return api?.ensureVideoPlayback
    ? { ensurePlayback: (assetId) => api.ensureVideoPlayback!(assetId) }
    : undefined;
}

export function cachedVideoFps(assetId: string) {
  return frameTimingIndexes.get(assetId)?.fps ?? fpsHints.get(assetId) ?? playbackUrlCache.get(assetId)?.fps ?? 30;
}

export function cachedVideoFrameCount(assetId: string) {
  return frameTimingIndexes.get(assetId)?.frameCount ?? frameCountHints.get(assetId) ?? playbackUrlCache.get(assetId)?.frameCount;
}

export function hasCachedVideoFrameIndex(assetId: string) {
  return frameTimingIndexes.has(assetId);
}

export function rememberVideoFrameIndex(index: VideoFrameTimingIndex) {
  if (!index.assetId || !Number.isFinite(index.fps) || index.fps <= 0
    || !Number.isFinite(index.frameCount) || index.frameCount <= 0
    || index.frames.length !== Math.round(index.frameCount)) return false;
  let previousPts = -1;
  const frames: Array<[number, number]> = [];
  for (const entry of index.frames) {
    const ptsUs = Number(entry?.[0]);
    const durationUs = Number(entry?.[1]);
    if (!Number.isFinite(ptsUs) || ptsUs < 0 || ptsUs <= previousPts
      || !Number.isFinite(durationUs) || durationUs < 0) return false;
    frames.push([ptsUs, durationUs]);
    previousPts = ptsUs;
  }
  const normalized: VideoFrameTimingIndex = {
    ...index,
    frameCount: frames.length,
    frames,
  };
  frameTimingIndexes.set(index.assetId, normalized);
  rememberVideoTiming(index.assetId, index.fps, frames.length);
  return true;
}

export function cachedVideoFrameTime(assetId: string, frame: number) {
  const index = frameTimingIndexes.get(assetId);
  if (!index?.frames.length) return undefined;
  const targetFrame = Math.max(0, Math.min(index.frames.length - 1, Math.round(frame)));
  const [ptsUs, declaredDurationUs] = index.frames[targetFrame];
  const nextPtsUs = index.frames[targetFrame + 1]?.[0];
  const inferredDurationUs = nextPtsUs !== undefined && nextPtsUs > ptsUs
    ? nextPtsUs - ptsUs
    : Math.max(1, declaredDurationUs || Math.round(1_000_000 / Math.max(1, index.fps)));
  const durationUs = declaredDurationUs > 0
    ? Math.min(declaredDurationUs, inferredDurationUs)
    : inferredDurationUs;
  const midpointUs = ptsUs + Math.max(1, durationUs) / 2;
  const lastSafeUs = index.durationUs > 0 ? Math.max(0, index.durationUs - 1) : midpointUs;
  return Math.min(lastSafeUs, midpointUs) / 1_000_000;
}

export function cachedVideoFrameAtTime(assetId: string, time: number) {
  const frames = frameTimingIndexes.get(assetId)?.frames;
  if (!frames?.length || !Number.isFinite(time)) return undefined;
  const targetUs = Math.max(0, time) * 1_000_000;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle][0] <= targetUs + 0.5) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function isVideoProxyPending(assetId: string) {
  return pendingProxy.has(assetId);
}

export function invalidateVideoPlaybackUrl(assetId: string) {
  playbackUrlCache.delete(assetId);
  pendingProxy.delete(assetId);
}

function playbackProtocolUrl(assetId: string) {
  return assetResourceUrl(assetId, new URLSearchParams({ variant: 'playback' }));
}

function originalProtocolUrl(assetId: string) {
  return assetResourceUrl(assetId, new URLSearchParams({ variant: 'original' }));
}

/**
 * Try the original asset first so WebView-supported codecs start immediately.
 * A decode failure marks that asset for the H.264 proxy fallback.
 */
export async function resolveVideoPlaybackUrl(assetId: string, playback?: VideoPlaybackLookup) {
  const cached = playbackUrlCache.get(assetId);
  if (cached?.url) return cached.url;

  if (!rejectedOriginals.has(assetId)) {
    const url = originalProtocolUrl(assetId);
    playbackUrlCache.set(assetId, {
      url,
      fps: fpsHints.get(assetId) ?? 30,
      frameCount: frameCountHints.get(assetId),
      kind: 'original',
    });
    return url;
  }

  if (playback?.ensurePlayback) {
    try {
      const result = await playback.ensurePlayback(assetId);
      rememberVideoTiming(assetId, result.fps, result.frameCount ?? undefined);
      if (result.ready) {
        pendingProxy.delete(assetId);
        const url = playbackProtocolUrl(assetId);
        playbackUrlCache.set(assetId, {
          url,
          fps: result.fps || 30,
          frameCount: result.frameCount ?? frameCountHints.get(assetId),
          kind: 'proxy',
        });
        return url;
      }
      if (result.unsupportedReason) {
        pendingProxy.delete(assetId);
        throw new Error(`视频无法创建兼容播放代理：${result.unsupportedReason}`);
      }
      pendingProxy.add(assetId);
      return undefined;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('视频无法创建兼容播放代理：')) {
        pendingProxy.delete(assetId);
        throw error;
      }
      pendingProxy.add(assetId);
      console.warn('ensureVideoPlayback failed', assetId, error);
      return undefined;
    }
  }

  pendingProxy.add(assetId);
  return undefined;
}

export function rejectOriginalVideoPlayback(assetId: string) {
  rejectedOriginals.add(assetId);
  if (playbackUrlCache.get(assetId)?.kind === 'original') playbackUrlCache.delete(assetId);
}

export function isOriginalVideoPlayback(assetId: string) {
  return playbackUrlCache.get(assetId)?.kind === 'original';
}

export function rememberVideoTiming(assetId: string, fps = 30, frameCount?: number) {
  if (Number.isFinite(fps) && fps > 0) fpsHints.set(assetId, fps);
  if (frameCount !== undefined && Number.isFinite(frameCount) && frameCount > 0) {
    frameCountHints.set(assetId, Math.round(frameCount));
  }
  const cached = playbackUrlCache.get(assetId);
  if (cached) {
    cached.fps = fpsHints.get(assetId) ?? cached.fps;
    cached.frameCount = frameCountHints.get(assetId) ?? cached.frameCount;
  }
}

export function rememberVideoProxy(assetId: string, fps = 30, frameCount?: number) {
  pendingProxy.delete(assetId);
  rememberVideoTiming(assetId, fps, frameCount);
  playbackUrlCache.set(assetId, {
    url: playbackProtocolUrl(assetId),
    fps: cachedVideoFps(assetId),
    frameCount: cachedVideoFrameCount(assetId),
    kind: 'proxy',
  });
}
