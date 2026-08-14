import type {
  VideoPreparationProgress,
  VideoPreparationResult,
  VideoProxyFailed,
  VideoProxyReady,
} from '../../types';

/** Platform video jobs that the canvas runtime consumes. App wires this from `window.refCanvas`. */
export interface VideoPlaybackHost {
  ensurePlayback(assetId: string): Promise<VideoPreparationResult>;
  cancelPlayback?(assetId: string): void;
  /** Fire-and-forget background index so jogging gets real fps before first play. */
  prepareIndex?(assetId: string): void;
  onProxyReady(callback: (payload: VideoProxyReady) => void): () => void;
  onProxyFailed?(callback: (payload: VideoProxyFailed) => void): () => void;
  onPreparationProgress?(callback: (payload: VideoPreparationProgress) => void): () => void;
}

export function videoPlaybackHostFromApi(api: Window['refCanvas'] | undefined): VideoPlaybackHost | undefined {
  if (!api?.ensureVideoPlayback) return undefined;
  return {
    ensurePlayback: (assetId) => api.ensureVideoPlayback!(assetId),
    cancelPlayback: api.cancelVideoPlayback?.bind(api),
    prepareIndex: api.prepareVideoIndex?.bind(api),
    onProxyReady: api.onVideoProxyReady
      ? (callback) => api.onVideoProxyReady!(callback)
      : () => () => undefined,
    onProxyFailed: api.onVideoProxyFailed?.bind(api),
    onPreparationProgress: api.onVideoPreparationProgress?.bind(api),
  };
}
