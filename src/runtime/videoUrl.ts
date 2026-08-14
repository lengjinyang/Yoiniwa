import { assetResourceUrl } from '../assetResourceUrl';
import type { VideoPreparationResult } from '../types';

type PlaybackUrlKind = 'original' | 'proxy';

const playbackUrlCache = new Map<string, { url: string; fps: number; frameCount?: number; kind: PlaybackUrlKind }>();
const fpsHints = new Map<string, number>();
const frameCountHints = new Map<string, number>();
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
  return fpsHints.get(assetId) ?? playbackUrlCache.get(assetId)?.fps ?? 30;
}

export function cachedVideoFrameCount(assetId: string) {
  return frameCountHints.get(assetId) ?? playbackUrlCache.get(assetId)?.frameCount;
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

function rememberVideoTiming(assetId: string, fps = 30, frameCount?: number) {
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

export function rememberVideoProxy(assetId: string, _path: string, fps = 30, frameCount?: number) {
  pendingProxy.delete(assetId);
  rememberVideoTiming(assetId, fps, frameCount);
  playbackUrlCache.set(assetId, {
    url: playbackProtocolUrl(assetId),
    fps: cachedVideoFps(assetId),
    frameCount: cachedVideoFrameCount(assetId),
    kind: 'proxy',
  });
}
