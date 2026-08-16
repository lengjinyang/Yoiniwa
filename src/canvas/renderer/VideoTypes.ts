import type { Sprite, Graphics, Texture, CanvasSource } from 'pixi.js';
import type { VideoFrameSize } from './VideoPerformancePolicy';
import type { VideoRuntimeStats } from '../../runtime/videoRuntimeStats';

export type { VideoRuntimeStats };

type VideoPlaybackPhase = 'paused' | 'loading' | 'playing' | 'suspended' | 'proxy-pending' | 'error';
export type VideoSeekInteractionKind = 'timeline' | 'canvas-jog';

export interface VideoTransportState {
  id: string;
  phase: VideoPlaybackPhase;
  playing: boolean;
  loading: boolean;
  currentTime: number;
  duration: number;
  fps: number;
  frameCount?: number;
  targetFrame: number;
  displayedFrame: number;
  preparationStage?: string;
  preparationProgress: number;
  muted: boolean;
  rate: number;
  ready: boolean;
}

export interface VideoRenderObject {
  id: string;
  assetId?: string;
  sprite: Sprite;
  badge: Graphics;
  video?: HTMLVideoElement;
  surface?: HTMLCanvasElement;
  surfaceContext?: CanvasRenderingContext2D;
  videoSource?: CanvasSource;
  videoTexture?: Texture;
  videoFrameCallback?: number;
  frameSize?: VideoFrameSize;
  desiredFrameSize?: VideoFrameSize;
  surfaceResizeAt?: number;
  surfaceResizeTimer?: number;
  frameDirty: boolean;
  frameSequence: number;
  lastUploadedTime: number;
  lastUploadAt: number;
  lastPresentedFrames?: number;
  lastPresentedMediaTime?: number;
  presentedTime?: number;
  posterKey?: string;
  posterAssetId?: string;
  posterTexture?: Texture;
  posterEdge?: number;
  posterTargetEdge?: number;
  posterLoading: boolean;
  posterToken: number;
  posterReleaseTimer?: number;
  decoderReleaseTimer?: number;
  intent: boolean;
  intentOrder: number;
  phase: VideoPlaybackPhase;
  currentTime: number;
  displayedFrame: number;
  seekInteraction?: { kind: VideoSeekInteractionKind; originFrame: number; resumeAfter: boolean };
  interactionEnding?: boolean;
  interactionTargetTime?: number;
  interactionTargetFrame?: number;
  pendingSeekTime?: number;
  seekFrame?: number;
  interactionSeekInFlight: boolean;
  seekGeneration: number;
  preparationStage?: string;
  preparationProgress: number;
  liveVideoPromise?: Promise<void>;
  playToken: number;
  loadToken: number;
  fps: number;
  frameCount?: number;
  rate: number;
  buffering: boolean;
  visible: boolean;
  prefetched: boolean;
  lastTransportAt: number;
  destroy(): void;
}
