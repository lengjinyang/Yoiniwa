import type { Sprite, Graphics, Texture, CanvasSource } from 'pixi.js';
import type { VideoFrameSize } from './VideoPerformancePolicy';

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
  preparationStage?: string;
  preparationProgress: number;
  muted: boolean;
  rate: number;
  ready: boolean;
}

export interface VideoRuntimeStats {
  playbackIntents: number;
  activeDecoders: number;
  suspendedVideos: number;
  posterTextures: number;
  frameUploads: number;
  frameUploadBytes: number;
  droppedFrames: number;
  uploadFps: number;
  droppedFps: number;
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
  pendingSeekTime?: number;
  seekFrame?: number;
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
